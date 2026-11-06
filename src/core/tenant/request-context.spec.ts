import { ClsService, ClsServiceManager } from 'nestjs-cls';
import { NodeEnv } from '../config/env.validation.js';
import type { AppConfigService } from '../config/app-config.service.js';
import { PhaseOneAdminAuth } from '../endpoint/endpoint-auth.js';
import { MissingContextError, RequestContext } from './request-context.js';

const cls = (): ClsService => ClsServiceManager.getClsService();

describe('请求上下文 RequestContext', () => {
  const ctx = () => new RequestContext(cls());
  const principal = { tenantId: '1', userId: '7', orgId: '3' };

  it('没有上下文时读取直接报错，不落到默认租户', () => {
    expect(() => ctx().current()).toThrow(MissingContextError);
    expect(ctx().peek()).toBeUndefined();
  });

  it('请求里由认证守卫写一次，之后不能再改', async () => {
    await cls().run(async () => {
      const c = ctx();
      c.establish('admin', principal);
      expect(c.current()).toEqual({
        endpoint: 'admin',
        ...principal,
        ignoreTenant: false,
      });
      expect(() =>
        c.establish('admin', { ...principal, tenantId: '2' }),
      ).toThrow(/不能再改/);
      expect(Object.isFrozen(c.current())).toBe(true);
    });
  });

  it('run 给后台任务指定租户，结束后不留到外面', async () => {
    const c = ctx();
    const seen = await c.run({ tenantId: '5' }, async () => c.current());
    expect(seen).toMatchObject({
      endpoint: 'system',
      tenantId: '5',
      userId: null,
      orgId: null,
    });
    expect(() => c.current()).toThrow(MissingContextError);
  });

  it.each([
    ['租户编号不是数字', { tenantId: 'abc' }],
    ['租户编号带前导 0', { tenantId: '01' }],
    ['用户编号格式错', { tenantId: '1', userId: 'x' }],
  ])('%s：拒绝', async (_name, p) => {
    await expect(ctx().run(p as never, async () => 1)).rejects.toThrow(
      /格式不正确/,
    );
  });

  it('跨租户只有平台租户能打开', async () => {
    await cls().run(async () => {
      const c = ctx();
      c.establish('admin', principal);
      expect(() => c.allowCrossTenant()).toThrow(/平台管理员/);
    });
    await cls().run(async () => {
      const c = ctx();
      c.establish('admin', { ...principal, tenantId: '0' });
      c.allowCrossTenant();
      const snap = c.current();
      expect(snap.ignoreTenant).toBe(true);
      // 打开跨租户之后快照仍然不能改：租户、审计主体、只读标记都改不了
      expect(Object.isFrozen(snap)).toBe(true);
      expect(Object.isFrozen(c.peek())).toBe(true);
      expect(() => {
        (snap as { tenantId: string }).tenantId = '9';
      }).toThrow(TypeError);
      expect(() => {
        (snap as { ignoreTenant: boolean }).ignoreTenant = false;
      }).toThrow(TypeError);
      expect(c.current()).toMatchObject({ tenantId: '0', ignoreTenant: true });
    });
  });
});

describe('阶段 1 后台认证占位', () => {
  const auth = (nodeEnv: NodeEnv) =>
    new PhaseOneAdminAuth({
      isProduction: nodeEnv === NodeEnv.Production,
    } as AppConfigService);

  it('生产环境启动时直接拒绝', () => {
    expect(() => auth(NodeEnv.Production).onModuleInit()).toThrow(
      /生产环境不能启动/,
    );
    expect(() => auth(NodeEnv.Development).onModuleInit()).not.toThrow();
  });

  it('开发和测试里返回默认租户的匿名用户', async () => {
    await expect(auth(NodeEnv.Test).authenticate()).resolves.toEqual({
      tenantId: '1',
      userId: null,
      orgId: null,
    });
  });
});
