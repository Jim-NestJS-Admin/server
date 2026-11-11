import {
  HttpStatus,
  Injectable,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { PermissionService } from '../permission/permission.service.js';
import type { Request } from 'express';
import { AppConfigService } from '../config/app-config.service.js';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';
import { RequestContext } from '../tenant/request-context.js';
import { PLATFORM_TENANT_ID } from '../tenant/tenant.constants.js';
import { TenantResolver, type TenantHint } from '../tenant/tenant-resolver.js';
import { BuiltinTenantSource, TenantSource } from '../tenant/tenant-source.js';
import { AuthEvents, type LoginEvent } from './auth-events.js';
import { AuthUserStore, type AuthOrg } from './auth-user.store.js';
import {
  CaptchaProvider,
  type CaptchaChallenge,
} from './captcha/captcha.provider.js';
import type { LoginDto, ProfileResult, TokenResult } from './dto/auth.dto.js';
import { clientIp, unauthorized } from './http.js';
import { LoginAttempts } from './login-attempts.service.js';
import { normalizeUsername, PasswordHasher } from './password.js';
import { SessionService, type SessionInfo } from './session.service.js';
import { TokenService } from './token.service.js';

/** 登录、刷新、切换组织成功后的结果：访问令牌给前端，刷新令牌由控制器写进 Cookie */
export interface IssuedTokens {
  body: TokenResult;
  refreshToken: string;
}

const captchaError = () =>
  new BusinessException(ErrorCode.BadRequest, '验证码错误，请重新输入', 400, {
    errors: [{ field: 'captchaCode', messages: ['验证码错误，请重新输入'] }],
  });

const credentialsError = () =>
  new BusinessException(ErrorCode.BadRequest, '账号或密码错误', 400, null);

/**
 * 后台登录认证流程（架构「认证与权限 · 登录认证」、契约 auth-session.md）。
 * 登录顺序：锁定检查 → 人机验证（含难度、一次性认领）→ 账号密码 → 读失效版本、复核账号 → 原子建会话。
 * 题目不对不核对密码、不计失败次数；账号不存在、密码错、已停用一律「账号或密码错误」并计数。
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');
  @Optional()
  @Inject(PermissionService)
  private readonly permissions?: PermissionService;
  // 单独测试认证时可以不装租户模块，按只有平台和默认租户处理
  @Optional()
  @Inject(TenantSource)
  private readonly tenantSource?: TenantSource;
  private get tenants(): TenantSource {
    return this.tenantSource ?? new BuiltinTenantSource();
  }

  /** 登录页要不要填租户编码（契约 tenant.md 第 4 节） */
  tenantHint(req: Request): Promise<TenantHint> {
    return new TenantResolver(this.tenants).hint(req);
  }

  constructor(
    private readonly config: AppConfigService,
    private readonly context: RequestContext,
    private readonly users: AuthUserStore,
    private readonly captcha: CaptchaProvider,
    private readonly attempts: LoginAttempts,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly events: AuthEvents,
  ) {}

  private get tenantId(): string {
    return this.context.current().tenantId;
  }

  /** 出登录题：绑定租户、规范化账号和这个账号（及 IP）当前的难度 */
  async createLoginChallenge(
    account: string,
    req: Request,
  ): Promise<CaptchaChallenge> {
    const tenantId = this.tenantId;
    const subject = normalizeUsername(account);
    const level = await this.attempts.level(tenantId, subject, clientIp(req));
    return this.captcha.create({ purpose: 'login', tenantId, subject }, level);
  }

  async login(dto: LoginDto, req: Request): Promise<IssuedTokens> {
    const tenantId = this.tenantId;
    const username = normalizeUsername(dto.username);
    const ip = clientIp(req);
    const ev: LoginEvent = {
      tenantId,
      username,
      userId: null,
      ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
    };

    try {
      await this.attempts.assertNotLocked(tenantId, username, ip);
    } catch (e) {
      await this.emit(() =>
        this.events.loginFailed({ ...ev, reason: 'locked' }),
      );
      throw e;
    }

    const required = await this.attempts.captchaRequired(
      tenantId,
      username,
      ip,
    );
    if (required || dto.captchaId) {
      const minLevel = await this.attempts.level(tenantId, username, ip);
      const result = await this.captcha.verify(
        dto.captchaId ?? '',
        dto.captchaCode ?? '',
        { purpose: 'login', tenantId, subject: username },
        minLevel,
      );
      if (!result.ok) {
        // 具体原因只写服务端日志，不告诉前端
        this.logger.warn({
          event: 'auth.captcha-rejected',
          reason: result.reason,
          username,
          ip,
        });
        await this.emit(() =>
          this.events.loginFailed({ ...ev, reason: 'captcha' }),
        );
        throw captchaError();
      }
    }

    const user = await this.users.findForLogin(tenantId, username);
    const passwordOk = await PasswordHasher.verify(
      dto.password,
      user?.passwordHash,
    );
    if (!user || !passwordOk || !user.enabled) {
      await this.attempts.recordFailure(tenantId, username, ip);
      await this.emit(() =>
        this.events.loginFailed({
          ...ev,
          userId: user?.id ?? null,
          reason: user && passwordOk ? 'disabled' : 'credentials',
        }),
      );
      throw credentialsError();
    }

    // 防在途登录：先读失效版本，再重新读一次账号确认仍可用、密码没换，最后建会话时原子核对版本。
    // T07 改密、停用的顺序是「数据库提交 → revokeUser（版本加 1）」，所以要么这里读到的是新数据，
    // 要么版本在读之后变了、建会话失败，不会有用旧密码或已停用账号建出来的会话。
    const epoch = await this.sessions.userEpoch(tenantId, user.id);
    const again = await this.users.findForLogin(tenantId, username);
    if (
      !again?.enabled ||
      again.id !== user.id ||
      again.passwordHash !== user.passwordHash
    )
      throw credentialsError();
    const orgs = await this.users.listOrgs(tenantId, user.id);
    const org = orgs.find((o) => o.id === user.defaultOrgId) ?? orgs[0] ?? null;
    const created = await this.sessions.create({
      tenantId,
      userId: user.id,
      orgId: org?.id ?? null,
      ip,
      userAgent: ev.userAgent,
      expectedEpoch: epoch,
    });
    if (!created)
      throw new BusinessException(
        ErrorCode.BadRequest,
        '登录失败，请重试',
        400,
        null,
      );
    const { session, refreshToken } = created;
    await this.attempts.reset(tenantId, username);
    await this.emit(() =>
      this.events.loginSucceeded({
        ...ev,
        userId: user.id,
        sessionId: session.sessionId,
      }),
    );
    return { body: await this.issue(tenantId, session), refreshToken };
  }

  /** 用刷新令牌换新的访问令牌和刷新令牌。失败一律 401，旧令牌被重复使用时整个会话已吊销 */
  async refresh(
    refreshToken: string | null,
    req: Request,
  ): Promise<IssuedTokens> {
    if (!refreshToken) throw unauthorized();
    const tenantId = this.tenantId;
    const r = await this.sessions.rotate(tenantId, refreshToken);
    if (r.status === 'reuse') {
      await this.emit(() =>
        this.events.refreshReuseDetected({
          tenantId,
          userId: r.userId,
          sessionId: r.sessionId,
          ip: clientIp(req),
        }),
      );
      throw unauthorized();
    }
    if (r.status !== 'ok') throw unauthorized();
    // 账号停用应当已经吊销会话（AuthUserStore 的约定）；这里再核对一次，防止漏调
    const profile = await this.users.findProfile(tenantId, r.session.userId);
    if (!profile?.enabled) {
      await this.sessions.revoke(tenantId, r.session.sessionId);
      throw unauthorized();
    }
    return {
      body: await this.issue(tenantId, r.session),
      refreshToken: r.refreshToken,
    };
  }

  /** 退出：吊销 Cookie 里的刷新令牌所属会话，以及访问令牌所属会话（两者通常是同一个） */
  async logout(sessionIds: (string | null)[]): Promise<void> {
    const tenantId = this.tenantId;
    for (const sid of new Set(sessionIds.filter((s): s is string => !!s))) {
      const userId = await this.sessions.revoke(tenantId, sid);
      if (userId)
        await this.emit(() =>
          this.events.loggedOut({ tenantId, userId, sessionId: sid }),
        );
    }
  }

  async sessionOfRefreshToken(token: string | null): Promise<string | null> {
    return token
      ? this.sessions.sessionOfRefreshToken(this.tenantId, token)
      : null;
  }

  async switchOrg(sessionId: string, orgId: string): Promise<IssuedTokens> {
    const { tenantId, userId } = this.context.current();
    if (!userId) throw unauthorized();
    const orgs = await this.users.listOrgs(tenantId, userId);
    if (!orgs.some((o) => o.id === orgId))
      throw new BusinessException(
        ErrorCode.Forbidden,
        '没有权限',
        HttpStatus.FORBIDDEN,
      );
    const r = await this.sessions.switchOrg(tenantId, sessionId, orgId);
    if (r.status !== 'ok') throw unauthorized();
    return {
      body: await this.issue(tenantId, r.session),
      refreshToken: r.refreshToken,
    };
  }

  async profile(): Promise<ProfileResult> {
    const { tenantId, userId, orgId } = this.context.current();
    if (!userId) throw unauthorized();
    const p = await this.users.findProfile(tenantId, userId);
    if (!p?.enabled) throw unauthorized();
    const orgs = await this.users.listOrgs(tenantId, userId);
    const pick = (o: AuthOrg) => ({ id: o.id, name: o.name, path: o.path });
    const current = orgs.find((o) => o.id === orgId);
    const tenant = await this.tenants.byId(tenantId);
    if (!tenant?.enabled) throw unauthorized();
    return {
      tenant: {
        id: tenant.id,
        code: tenant.code,
        name: tenant.name,
        platform: tenant.id === PLATFORM_TENANT_ID,
      },
      user: {
        id: p.id,
        username: p.username,
        nickname: p.nickname,
        avatar: p.avatar,
      },
      currentOrg: current ? pick(current) : null,
      orgs: orgs.map(pick),
      superAdmin: (await this.permissions?.isSuperAdmin()) ?? false,
      locale: p.locale || 'zh-CN',
    };
  }

  get refreshTtlSeconds(): number {
    return this.config.auth.refreshTtlSeconds;
  }

  private async issue(tenantId: string, s: SessionInfo): Promise<TokenResult> {
    const accessToken = await this.tokens.sign({
      tenantId,
      userId: s.userId,
      sessionId: s.sessionId,
      sessionVersion: s.version,
      orgId: s.orgId,
    });
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
    };
  }

  /** 事件处理出错不影响登录本身 */
  private async emit(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.logger.error({ event: 'auth.event-failed', err: e });
    }
  }
}
