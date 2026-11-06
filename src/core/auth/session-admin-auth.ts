import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuth } from '../endpoint/endpoint-auth.js';
import type { Principal } from '../tenant/request-context.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenant.constants.js';
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
  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
  ) {
    super();
  }

  /** 阶段 1 只有一个业务租户；阶段 2 按访问的域名解析 */
  async resolveTenant(): Promise<string> {
    return DEFAULT_TENANT_ID;
  }

  async authenticate(req: Request): Promise<Principal> {
    const token = readBearer(req);
    if (!token) throw unauthorized();
    const claims = await this.tokens.verify(token);
    if (!claims || claims.tenantId !== (await this.resolveTenant()))
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
