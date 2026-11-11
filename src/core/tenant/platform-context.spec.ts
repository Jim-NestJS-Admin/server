import { ClsService, ClsServiceManager } from 'nestjs-cls';
import { BusinessException } from '../exceptions/business.exception.js';
import {
  PlatformAuditSink,
  PlatformContext,
  type PlatformAuditEntry,
} from './platform-context.js';
import { RequestContext } from './request-context.js';
import { BuiltinTenantSource } from './tenant-source.js';

const cls = (): ClsService => ClsServiceManager.getClsService();

class MemorySink extends PlatformAuditSink {
  entries: PlatformAuditEntry[] = [];
  fail = false;
  async record(entry: PlatformAuditEntry): Promise<void> {
    if (this.fail) throw new Error('写不进去');
    this.entries.push(entry);
  }
}

describe('平台受控入口 PlatformContext', () => {
  const setup = () => {
    const context = new RequestContext(cls());
    const sink = new MemorySink();
    return { context, sink, platform: new PlatformContext(context, sink) };
  };

  it('平台用户可以初始化新租户：先记审计，读写落在新租户，创建人为空', async () => {
    const { context, sink, platform } = setup();
    await cls().run(async () => {
      context.establish('admin', { tenantId: '0', userId: '9', orgId: '1' });
      const inside = await platform.provision('5', '新建租户 demo', async () =>
        context.current(),
      );
      expect(inside).toMatchObject({ tenantId: '5', userId: null });
      expect(sink.entries).toEqual([
        {
          action: 'provision',
          userId: '9',
          targetTenantId: '5',
          detail: '新建租户 demo',
        },
      ]);
      // 结束后回到平台自己的上下文
      expect(context.current().tenantId).toBe('0');
    });
  });

  it('租户用户不能调用，返回 403', async () => {
    const { context, platform } = setup();
    await cls().run(async () => {
      context.establish('admin', { tenantId: '1', userId: '7', orgId: '3' });
      expect(platform.isPlatform()).toBe(false);
      expect(() => platform.assertPlatform()).toThrow(BusinessException);
      await expect(
        platform.provision('2', 'x', async () => 1),
      ).rejects.toBeInstanceOf(BusinessException);
    });
  });

  it('不能初始化平台自己；审计写不进去就不执行', async () => {
    const { context, sink, platform } = setup();
    await cls().run(async () => {
      context.establish('admin', { tenantId: '0', userId: '9', orgId: '1' });
      await expect(platform.provision('0', 'x', async () => 1)).rejects.toThrow(
        /普通租户/,
      );
      sink.fail = true;
      let ran = false;
      await expect(
        platform.provision('5', 'x', async () => {
          ran = true;
        }),
      ).rejects.toThrow(/写不进去/);
      expect(ran).toBe(false);
    });
  });
});

describe('内置租户目录 BuiltinTenantSource', () => {
  it('只有平台和默认租户，没有域名绑定，套餐不限', async () => {
    const s = new BuiltinTenantSource();
    expect(await s.byCode('platform')).toMatchObject({ id: '0' });
    expect(await s.byCode('default')).toMatchObject({ id: '1', enabled: true });
    expect(await s.byCode('demo')).toBeNull();
    expect(await s.byId('1')).toMatchObject({ code: 'default' });
    expect(await s.byDomain('admin.example.com')).toBeNull();
    expect(await s.packageMenuIds('1')).toBeNull();
  });
});
