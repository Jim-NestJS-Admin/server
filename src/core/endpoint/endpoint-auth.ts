import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Principal } from '../tenant/request-context.js';

/**
 * 后台端认证：从请求里取令牌、每次核对会话，返回可信身份；不通过就抛 401 / 403 / 503。
 * 正式实现是 core/auth 的 SessionAdminAuth（T05）。
 */
export abstract class AdminAuth {
  abstract authenticate(req: Request): Promise<Principal>;
  /** 免登录的后台接口（@Anonymous）：只确定租户（域名优先 + 租户编码，契约 tenant.md 第 4 节） */
  abstract resolveTenant(req: Request): Promise<string>;
}

/**
 * 后台端授权：认证通过、身份写进上下文之后调用，核对这个接口的权限码（T06 的 PermissionAuthorizer）。
 * 免登录（@Anonymous）的接口不调用。
 */
export abstract class AdminAuthorizer {
  abstract authorize(ctx: ExecutionContext): Promise<void>;
}
