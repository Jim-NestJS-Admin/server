import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import { BusinessException } from '../exceptions/business.exception.js';
import {
  PlatformAuditSink,
  type PlatformAuditEntry,
} from '../tenant/platform-context.js';
import { RequestContext, type Principal } from '../tenant/request-context.js';
import { AdminAuth } from './endpoint-auth.js';
import { AdminController, IgnoreTenant } from './endpoint.decorators.js';
import { EndpointGuard } from './endpoint.guard.js';

@AdminController('platform/look')
class LookController {
  @IgnoreTenant()
  usage() {}
}

class FixedAuth extends AdminAuth {
  constructor(private readonly who: Principal) {
    super();
  }
  async resolveTenant(): Promise<string> {
    return this.who.tenantId;
  }
  async authenticate(): Promise<Principal> {
    return this.who;
  }
}

class Sink extends PlatformAuditSink {
  entries: PlatformAuditEntry[] = [];
  fail = false;
  async record(e: PlatformAuditEntry): Promise<void> {
    if (this.fail) throw new Error('db down');
    this.entries.push(e);
  }
}

const exec = () =>
  ({
    getType: () => 'http',
    getClass: () => LookController,
    getHandler: () => Reflect.get(LookController.prototype, 'usage') as unknown,
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', path: '/admin/platform/look' }),
    }),
  }) as never;

const cls = () => ClsServiceManager.getClsService();

describe('EndpointGuard：@IgnoreTenant 跨租户只读要留审计', () => {
  const run = async (who: Principal, sink: Sink) => {
    const context = new RequestContext(cls());
    const guard = new EndpointGuard(
      new Reflector(),
      context,
      new FixedAuth(who),
      { authorize: async () => undefined } as never,
      sink,
    );
    return cls().run(async () => {
      await guard.canActivate(exec());
      return context.current();
    });
  };
  const platform = { tenantId: '0', userId: '9', orgId: '1' };

  it('平台用户：先记审计再打开跨租户查询', async () => {
    const sink = new Sink();
    const ctx = await run(platform, sink);
    expect(ctx.ignoreTenant).toBe(true);
    expect(sink.entries).toEqual([
      expect.objectContaining({
        action: 'cross-tenant-read',
        userId: '9',
        detail: expect.stringContaining('LookController.usage'),
      }),
    ]);
  });

  it('审计写不进去：503，不查', async () => {
    const sink = new Sink();
    sink.fail = true;
    await expect(run(platform, sink)).rejects.toMatchObject({
      status: 503,
    });
  });

  it('租户用户：403，不记审计', async () => {
    const sink = new Sink();
    await expect(
      run({ tenantId: '1', userId: '7', orgId: '3' }, sink),
    ).rejects.toBeInstanceOf(BusinessException);
    expect(sink.entries).toEqual([]);
  });
});
