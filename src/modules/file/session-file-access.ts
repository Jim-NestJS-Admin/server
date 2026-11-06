import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../core/tenant/request-context.js';
import { AuthzContext } from '../../core/permission/authz-context.js';
import { BusinessException } from '../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../core/exceptions/error-code.js';
import {
  FileAccess,
  type FileAction,
  type FilePrincipal,
} from './file.ports.js';

/** 全局端守卫已经核对实时会话、组织和权限；这里要求对应授权结果，不重复建立授权上下文。 */
@Injectable()
export class SessionFileAccess extends FileAccess {
  constructor(
    private readonly context: RequestContext,
    private readonly authorization: AuthzContext,
  ) {
    super();
  }
  async current(action: FileAction): Promise<FilePrincipal> {
    const principal = this.context.peek();
    if (!principal?.userId || principal.endpoint !== 'admin')
      throw new BusinessException(ErrorCode.Unauthorized, '请先登录', 401);
    const allowed =
      action === 'upload'
        ? ['file:asset:upload']
        : ['file:asset:read', 'file:asset:page', 'file:asset:info'];
    const permission = this.authorization.get()?.permission;
    if (!permission || !allowed.includes(permission))
      throw new BusinessException(ErrorCode.Forbidden, '没有权限', 403);
    return { tenantId: principal.tenantId, userId: principal.userId };
  }
}
