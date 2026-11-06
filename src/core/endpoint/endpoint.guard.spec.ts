import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import { RequestContext } from '../tenant/request-context.js';
import { AdminAuth } from './endpoint-auth.js';
import { AdminController, Anonymous, Public } from './endpoint.decorators.js';
import { EndpointGuard } from './endpoint.guard.js';
import { LoginOnly, Perms } from '../permission/perms.decorator.js';

@AdminController('review')
class ReviewController {
  @Public()
  sneaky() {}

  normal() {}
}

@Public()
class InfraController {
  ping() {}
}

class DenyAuth extends AdminAuth {
  calls = 0;
  async resolveTenant(): Promise<string> {
    return '1';
  }
  async authenticate(): Promise<never> {
    this.calls++;
    throw new Error('denied');
  }
}

const exec = (cls: Function, method: string) =>
  ({
    getType: () => 'http',
    getClass: () => cls,
    getHandler: () => (cls.prototype as Record<string, Function>)[method],
    switchToHttp: () => ({ getRequest: () => ({ method: 'GET', path: '/' }) }),
  }) as never;

describe('EndpointGuard：@Public 只认控制器上的', () => {
  const setup = () => {
    const auth = new DenyAuth();
    const guard = new EndpointGuard(
      new Reflector(),
      new RequestContext(ClsServiceManager.getClsService()),
      auth,
      { authorize: async () => undefined } as never,
    );
    return { auth, guard };
  };

  it('后台控制器里方法上的 @Public 不生效：照样走认证', async () => {
    const { auth, guard } = setup();
    await expect(
      guard.canActivate(exec(ReviewController, 'sneaky')),
    ).rejects.toThrow('denied');
    await expect(
      guard.canActivate(exec(ReviewController, 'normal')),
    ).rejects.toThrow('denied');
    expect(auth.calls).toBe(2);
  });

  it('控制器上的 @Public：不走认证', async () => {
    const { auth, guard } = setup();
    await expect(
      guard.canActivate(exec(InfraController, 'ping')),
    ).resolves.toBe(true);
    expect(auth.calls).toBe(0);
  });
});

@Anonymous()
@AdminController('mixed')
class MixedAnonymousController {
  @Perms('review:secret:read')
  secret() {}

  @LoginOnly()
  me() {}
}

describe('EndpointGuard：@Anonymous 控制器里带权限声明（矛盾）', () => {
  it('不按免登录放行：403，认证和授权都没被调用', async () => {
    const auth = new DenyAuth();
    let authorized = 0;
    const guard = new EndpointGuard(
      new Reflector(),
      new RequestContext(ClsServiceManager.getClsService()),
      auth,
      {
        authorize: async () => {
          authorized++;
        },
      } as never,
    );
    for (const m of ['secret', 'me'])
      await expect(
        guard.canActivate(exec(MixedAnonymousController, m)),
      ).rejects.toMatchObject({ status: 403 });
    expect(auth.calls).toBe(0);
    expect(authorized).toBe(0);
  });
});
