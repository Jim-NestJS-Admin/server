import { Injectable, Optional } from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuth } from '../endpoint/endpoint-auth.js';
import type { Principal } from '../tenant/request-context.js';
import { TenantResolver } from '../tenant/tenant-resolver.js';
import { BuiltinTenantSource, TenantSource } from '../tenant/tenant-source.js';
import { readBearer, unauthorized, type AuthedRequest } from './http.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

/**
 * 后台端正式认证（T05）：Authorization: Bearer <访问令牌>。
 * 令牌签名、有效期通过后，每次请求都到 Redis 核对会话还在、版本没变；
 * 任何一项不对都是 401 / 4001（前端走刷新或回登录页），Redis 不可用是 503（不放行）。
 */
@Injectable()
export class SessionAdminAuth extends AdminAuth {
  private readonly resolver: TenantResolver;

  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    // 单独测试认证时可以不装租户模块，按只有平台和默认租户处理
    @Optional() tenants?: TenantSource,
  ) {
    super();
    this.resolver = new TenantResolver(tenants ?? new BuiltinTenantSource());
  }

  /** 免登录接口：域名优先，没绑定就看 X-Tenant-Code（契约 tenant.md 第 4 节） */
  resolveTenant(req: Request): Promise<string> {
    return this.resolver.anonymous(req);
  }

  async authenticate(req: Request): Promise<Principal> {
    const token = readBearer(req);
    if (!token) throw unauthorized();
    const claims = await this.tokens.verify(token);
    // 租户只认令牌里的；租户停用 / 过期、或请求域名绑定了别的租户都是 401
    if (!claims || !(await this.resolver.tokenAllowed(req, claims.tenantId)))
      throw unauthorized();
    const session = await this.sessions.verify(
      claims.tenantId,
      claims.sessionId,
      claims.userId,
      claims.sessionVersion,
    );
    if (!session) throw unauthorized();
    (req as AuthedRequest).jnaSession = { sessionId: session.sessionId };
    return {
      tenantId: claims.tenantId,
      userId: session.userId,
      orgId: session.orgId,
    };
  }
}
