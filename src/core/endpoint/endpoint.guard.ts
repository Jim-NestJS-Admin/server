import {
  HttpStatus,
  Injectable,
  Logger,
  Optional,
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
import {
  LoggerPlatformAuditSink,
  PlatformAuditSink,
} from '../tenant/platform-context.js';
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
    // 没装租户模块（单独测试）时只写日志
    @Optional() audit?: PlatformAuditSink,
  ) {
    this.audit = audit ?? new LoggerPlatformAuditSink();
  }
  private readonly audit: PlatformAuditSink;

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
    // 免登录接口上出现权限声明是矛盾的（启动检查会拦，这里第二道）：拒绝，不按免登录放行
    if (
      anonymous &&
      (this.reflector.get(PERMS_KEY, ctx.getHandler()) ||
        this.reflector.getAllAndOverride(LOGIN_ONLY_KEY, [
          ctx.getHandler(),
          ctx.getClass(),
        ]) ||
        this.reflector.get(PERMS_KEY, ctx.getClass()))
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
      // 平台只读查看租户数据，每次都留审计；审计写不进去就不查（契约 tenant.md 第 6 节）
      try {
        await this.audit.record({
          action: 'cross-tenant-read',
          userId: principal.userId,
          targetTenantId: null,
          detail: `${req.method} ${req.path}（${ctx.getClass().name}.${ctx.getHandler().name}）`,
        });
      } catch (e) {
        this.logger.error({
          event: 'tenant.cross-tenant.audit-failed',
          err: e,
        });
        throw new BusinessException(
          ErrorCode.ServiceUnavailable,
          '审计日志写入失败，请稍后重试',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      this.context.allowCrossTenant();
    }
    return true;
  }
}
