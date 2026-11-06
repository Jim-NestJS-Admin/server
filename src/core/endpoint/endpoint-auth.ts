import type { Request } from 'express';
import type { Principal } from '../tenant/request-context.js';

/**
 * 后台端认证：从请求里取令牌、每次核对会话，返回可信身份；不通过就抛 401 / 403 / 503。
 * 正式实现是 core/auth 的 SessionAdminAuth（T05）。
 */
export abstract class AdminAuth {
  abstract authenticate(req: Request): Promise<Principal>;
  /** 免登录的后台接口（@Anonymous）：只确定租户。阶段 1 固定默认租户，以后按域名解析 */
  abstract resolveTenant(req: Request): Promise<string>;
}
