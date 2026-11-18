import { Injectable } from '@nestjs/common';
import { SystemDirectory } from '../../system/service/system-directory.service.js';
import { createHash, randomBytes } from 'node:crypto';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { RedisService } from '../../../core/redis/redis.service.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { AuthUserStore } from '../../../core/auth/auth-user.store.js';
import { SessionService } from '../../../core/auth/session.service.js';
import { TokenService } from '../../../core/auth/token.service.js';
import { AuthEvents } from '../../../core/auth/auth-events.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { IntegrationAppService } from './integration-app.service.js';
import { WecomAdapter } from './wecom-adapter.js';
import { UserSocial } from '../entity/integration.entity.js';

@Injectable()
export class IntegrationLoginService {
  constructor(
    private readonly context: RequestContext,
    private readonly redis: RedisService,
    private readonly apps: IntegrationAppService,
    private readonly adapter: WecomAdapter,
    private readonly repos: TenantRepositoryFactory,
    private readonly users: AuthUserStore,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly events: AuthEvents,
    private readonly directory: SystemDirectory,
  ) {}
  async start(desktop: boolean, returnPath?: string) {
    const app = await this.apps.configured();
    if (!app) throw crudErrors.badRequest('企业微信登录尚未启用');
    const state = randomBytes(32).toString('base64url');
    const browser = randomBytes(32).toString('base64url');
    await this.redis.call((r) =>
      r.set(
        this.redis.tenantKey(
          this.context.current().tenantId,
          'wecom',
          'state',
          state,
        ),
        JSON.stringify({
          browser: createHash('sha256').update(browser).digest('hex'),
          appId: app.id,
          version: app.version,
        }),
        'EX',
        300,
      ),
    );
    const redirect = `${app.adminUrl}?wecom=1${returnPath ? '&next=' + encodeURIComponent(returnPath) : ''}`;
    const url = new URL(
      desktop
        ? 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect'
        : 'https://open.weixin.qq.com/connect/oauth2/authorize',
    );
    url.searchParams.set('appid', app.corpId);
    url.searchParams.set('agentid', app.agentId);
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.set('state', state);
    if (!desktop) {
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'snsapi_base');
      url.hash = 'wechat_redirect';
    }
    return { browser, body: { state, url: url.toString() } };
  }
  async login(
    state: string,
    code: string,
    browser: string | undefined,
    ip: string,
    userAgent: string,
  ) {
    const tenantId = this.context.current().tenantId;
    const stateKey = this.redis.tenantKey(tenantId, 'wecom', 'state', state);
    if (!browser) throw crudErrors.badRequest('企业微信登录请求已失效');
    const value = await this.redis.call((r) => r.getdel(stateKey));
    if (!value) throw crudErrors.badRequest('企业微信登录请求已失效');
    const saved = JSON.parse(value) as {
      browser: string;
      appId: string;
      version: number;
    };
    const app = await this.apps.configured();
    if (
      !app ||
      saved.appId !== app.id ||
      saved.version !== app.version ||
      saved.browser !== createHash('sha256').update(browser).digest('hex')
    )
      throw crudErrors.badRequest('企业微信登录请求已失效');
    const codeKey = this.redis.tenantKey(
      tenantId,
      'wecom',
      'code',
      createHash('sha256').update(code).digest('hex'),
    );
    if (
      !(await this.redis.call((r) => r.set(codeKey, 'used', 'EX', 600, 'NX')))
    )
      throw crudErrors.badRequest('授权码已使用');
    const externalId = await this.adapter.user(
      app,
      this.apps.credentials(app).secret,
      code,
    );
    const social = await this.repos
      .for(UserSocial)
      .query('s')
      .andWhere(
        's.corpId = :corpId AND s.externalId = :externalId AND s.platform = :platform',
        { corpId: app.corpId, externalId, platform: 'wecom' },
      )
      .getOne();
    if (!social) throw crudErrors.badRequest('请先由管理员同步企业成员');
    const epoch = await this.sessions.userEpoch(tenantId, social.userId);
    const profile = await this.users.findProfile(tenantId, social.userId);
    if (!profile?.enabled) throw crudErrors.badRequest('企业微信登录失败');
    const orgs = await this.users.listOrgs(tenantId, social.userId);
    const identity = await this.directory.notificationIdentity(social.userId);
    const currentOrg =
      orgs.find((org) => org.id === identity?.orgId) ?? orgs[0];
    if (!currentOrg) throw crudErrors.badRequest('账号尚未分配可用组织角色');
    const created = await this.sessions.create({
      tenantId,
      userId: social.userId,
      orgId: currentOrg.id,
      ip,
      userAgent,
      expectedEpoch: epoch,
    });
    if (!created) throw crudErrors.badRequest('企业微信登录失败，请重试');
    await this.events.loginSucceeded({
      tenantId,
      userId: social.userId,
      username: profile.username,
      sessionId: created.session.sessionId,
      ip,
      userAgent,
    });
    return {
      refreshToken: created.refreshToken,
      body: {
        accessToken: await this.tokens.sign({
          tenantId,
          userId: social.userId,
          sessionId: created.session.sessionId,
          sessionVersion: created.session.version,
          orgId: currentOrg.id,
        }),
        expiresIn: this.tokens.accessTtlSeconds,
        tokenType: 'Bearer' as const,
      },
    };
  }
}
