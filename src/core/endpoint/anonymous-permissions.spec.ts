import { Get, type ExecutionContext } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { EndpointCheck } from './endpoint-check.js';
import { EndpointGuard } from './endpoint.guard.js';
import { AdminController, Anonymous } from './endpoint.decorators.js';
import { LoginOnly, Perms } from '../permission/perms.decorator.js';
import { RequestContext } from '../tenant/request-context.js';
import { AdminAuth, AdminAuthorizer } from './endpoint-auth.js';

@Anonymous()
@AdminController('review/mixed')
class MixedController {
  @Get()
  @Perms('review:secret:read')
  read(this: void) {
    return '不能匿名访问';
  }
}

@Anonymous()
@AdminController('review/login-only')
@LoginOnly()
class LoginOnlyController {
  @Get()
  read() {
    return '不能匿名访问';
  }
}

@Anonymous()
@AdminController('review/inherited')
class InheritedController extends MixedController {}

describe('匿名声明冲突失败关闭', () => {
  for (const controller of [
    MixedController,
    LoginOnlyController,
    InheritedController,
  ]) {
    it(`${controller.name} 在启动时拒绝混合声明`, () => {
      const discovery = {
        getControllers: () => [{ metatype: controller }],
      } as unknown as DiscoveryService;
      expect(() => new EndpointCheck(discovery).onModuleInit()).toThrow(
        '免登录控制器不能混用',
      );
    });
  }

  it('即使没有运行启动检查，运行时也拒绝匿名访问权限方法', async () => {
    const resolveTenant = vi.fn();
    const ctx = {
      getType: () => 'http',
      getClass: () => MixedController,
      getHandler: () => MixedController.prototype.read,
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;
    const guard = new EndpointGuard(
      new Reflector(),
      {} as RequestContext,
      { resolveTenant } as unknown as AdminAuth,
      {} as AdminAuthorizer,
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow('没有权限');
    expect(resolveTenant).not.toHaveBeenCalled();
  });
});
