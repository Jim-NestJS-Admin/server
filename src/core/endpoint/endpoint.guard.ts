import {
  HttpStatus,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';
import {
  RequestContext,
  type EndpointKind,
} from '../tenant/request-context.js';
import { PLATFORM_TENANT_ID } from '../tenant/tenant.constants.js';
import { AdminAuth, AdminAuthorizer } from './endpoint-auth.js';
import { LOGIN_ONLY_KEY, PERMS_KEY } from '../permission/perms.decorator.js';
import {
  ANONYMOUS_KEY,
  ENDPOINT_KEY,
  IGNORE_TENANT_KEY,
  PUBLIC_KEY,
} from './endpoint.decorators.js';

/**
 * 全局守卫：按控制器所属的端调用对应的认证，把可信身份写进请求上下文（租户、用户、组织）。
 * 守卫在拦截器（含文件上传解析）之前执行，没通过认证的请求到不了业务代码。
 * 阶段 1 只有后台端；其他端没有认证实现时一律拒绝（启动检查也会拦住）。
 */
@Injectable()
export class EndpointGuard implements CanActivate {
  private readonly logger = new Logger('EndpointGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly context: RequestContext,
    private readonly adminAuth: AdminAuth,
    private readonly authorizer: AdminAuthorizer,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return false;
    // 只认控制器上的 @Public：方法上的标记不生效（启动检查也会直接拒绝），避免后台控制器里藏一个免登录的方法
    if (this.reflector.get<boolean>(PUBLIC_KEY, ctx.getClass())) return true;
    const endpoint = this.reflector.get<EndpointKind | undefined>(
      ENDPOINT_KEY,
      ctx.getClass(),
    );
    const req = ctx.switchToHttp().getRequest<Request>();
    if (endpoint !== 'admin')
      throw new BusinessException(
        ErrorCode.NotFound,
        '接口不存在',
        HttpStatus.NOT_FOUND,
      );

    // 同样只认控制器上的 @Anonymous
    const anonymous = this.reflector.get<boolean>(
      ANONYMOUS_KEY,
      ctx.getClass(),
    );
    if (
      anonymous &&
      [ctx.getClass(), ctx.getHandler()].some(
        (target) =>
          this.reflector.get(PERMS_KEY, target) ||
          this.reflector.get(LOGIN_ONLY_KEY, target),
      )
    )
      throw new BusinessException(
        ErrorCode.Forbidden,
        '没有权限',
        HttpStatus.FORBIDDEN,
      );
    const principal = anonymous
      ? {
          tenantId: await this.adminAuth.resolveTenant(req),
          userId: null,
          orgId: null,
        }
      : await this.adminAuth.authenticate(req);
    this.context.establish(endpoint, principal);
    // 权限码和本次有效角色（T06）。免登录的接口没有用户，不核对
    if (!anonymous) await this.authorizer.authorize(ctx);

    if (this.reflector.get<boolean>(IGNORE_TENANT_KEY, ctx.getHandler())) {
      if (principal.tenantId !== PLATFORM_TENANT_ID)
        throw new BusinessException(
          ErrorCode.Forbidden,
          '没有权限',
          HttpStatus.FORBIDDEN,
        );
      this.context.allowCrossTenant();
      this.logger.warn({
        event: 'tenant.cross-tenant',
        method: req.method,
        path: req.path,
        userId: principal.userId,
      });
    }
    return true;
  }
}
