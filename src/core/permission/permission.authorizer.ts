import { HttpStatus, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminAuthorizer } from '../endpoint/endpoint-auth.js';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';
import { PermissionService } from './permission.service.js';
import {
  LOGIN_ONLY_KEY,
  PERMS_KEY,
  type LoginOnlyMeta,
  type PermMeta,
} from './perms.decorator.js';

/**
 * 后台权限守卫（架构「统一请求处理链 · 权限守卫」）：
 * - @Perms（含通用 CRUD 自动生成的）：核对权限码，算本次有效角色和数据范围；
 * - @LoginOnly：登录就能用，只核对当前组织归属；
 * - 都没有：拒绝（启动检查会先拦住，这里是第二道）。
 * 权限码只认方法上的，不认控制器上的，避免一个控制器级的码把所有方法都放开。
 */
@Injectable()
export class PermissionAuthorizer extends AdminAuthorizer {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {
    super();
  }

  async authorize(ctx: ExecutionContext): Promise<void> {
    const perm = this.reflector.get<PermMeta | undefined>(
      PERMS_KEY,
      ctx.getHandler(),
    );
    if (perm) return this.permissions.authorize(perm.code);
    const loginOnly = this.reflector.getAllAndOverride<
      LoginOnlyMeta | undefined
    >(LOGIN_ONLY_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (loginOnly)
      return loginOnly.orgCheck
        ? this.permissions.assertMember()
        : this.permissions.assertUser();
    throw new BusinessException(
      ErrorCode.Forbidden,
      '没有权限',
      HttpStatus.FORBIDDEN,
    );
  }
}
