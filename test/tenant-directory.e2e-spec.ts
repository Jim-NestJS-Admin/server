import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { RequestContext } from '../src/core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../src/core/tenant/tenant-repository.js';
import { TenantDirectoryModule } from '../src/modules/tenant/tenant-directory.module.js';
import { TenantDirectorySource } from '../src/modules/tenant/service/tenant-directory.source.js';
import {
  SystemTenant,
  TenantPackage,
  TenantQuotas,
} from '../src/modules/tenant/entity/tenant.entity.js';
import { TenantCatalog1794412800000 } from '../src/database/migrations/1794412800000-TenantCatalog.js';
import { createTestModule } from './support/test-auth.js';

describe('T31 平台目录与迁移基础', () => {
  let app: INestApplication,
    ds: DataSource,
    source: TenantDirectorySource,
    context: RequestContext,
    repos: TenantRepositoryFactory;
  beforeAll(async () => {
    const module = await createTestModule({
      imports: [AppModule, TenantDirectoryModule],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    source = app.get(TenantDirectorySource);
    context = app.get(RequestContext);
    repos = app.get(TenantRepositoryFactory);
    if (ds.options.database !== 'jim_admin_integration_20261109_test')
      throw Error('T31只允许指定独立测试库');
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    if (ds.options.database !== 'jim_admin_integration_20261109_test')
      throw Error('拒绝清理其他库');
    await ds.query('DELETE FROM sys_tenant');
    await ds.query('DELETE FROM sys_package');
  });
  const seed = async () =>
    context.run({ tenantId: '0' }, async () => {
      const pack = await repos.for(TenantPackage).insert({
        code: 'basic',
        name: '基础版',
        enabled: true,
        menuIds: ['11', '12'],
        quotas: new TenantQuotas(),
        remark: null,
      });
      const id = await repos.for(SystemTenant).insert({
        code: 'demo',
        name: '演示租户',
        packageId: pack,
        domains: ['demo.example.com:8851'],
        enabled: true,
        expiresAt: null,
        contactName: null,
        contactPhone: null,
        remark: null,
      });
      return { id, pack };
    });
  it('登录前及普通租户上下文均只读平台目录，不受调用者租户编号影响', async () => {
    const { id } = await seed();
    const expected = { id, code: 'demo', name: '演示租户', enabled: true };
    expect(await source.byCode('demo')).toMatchObject(expected);
    await context.run({ tenantId: '987' }, async () => {
      expect(await source.byId(id)).toMatchObject(expected);
      expect(await source.byDomain('DEMO.EXAMPLE.COM:8851')).toMatchObject(
        expected,
      );
      expect(context.current().tenantId).toBe('987');
    });
    expect(await source.byCode('platform')).toMatchObject({
      id: '0',
      packageId: null,
    });
    expect(await source.byDomain('127.0.0.1:8851')).toBeNull();
    expect(await source.byId('987')).toBeNull();
    expect(await source.packageMenuIds('987')).toEqual([]);
  });
  it('停用/过期立即失效，停用套餐不影响已有租户，删除套餐收窄为无权限', async () => {
    const { id, pack } = await seed();
    expect(await source.packageMenuIds(id)).toEqual(['11', '12']);
    await context.run({ tenantId: '0' }, () =>
      repos.for(TenantPackage).update([pack], { enabled: false }),
    );
    expect(await source.packageMenuIds(id)).toEqual(['11', '12']);
    await context.run({ tenantId: '0' }, () =>
      repos
        .for(SystemTenant)
        .update([id], { expiresAt: new Date(Date.now() - 1000) }),
    );
    expect(await source.byId(id)).toMatchObject({ enabled: false });
    expect(await source.packageMenuIds(id)).toEqual([]);
    await context.run({ tenantId: '0' }, () =>
      repos.for(SystemTenant).update([id], { expiresAt: null, enabled: false }),
    );
    expect(await source.byCode('demo')).toMatchObject({ enabled: false });
    await context.run({ tenantId: '0' }, () =>
      repos.for(SystemTenant).update([id], { enabled: true }),
    );
    await ds.query(
      'UPDATE sys_package SET deleted_at=UTC_TIMESTAMP(3) WHERE id=?',
      [pack],
    );
    expect(await source.packageMenuIds(id)).toEqual([]);
    await ds.query(
      'UPDATE sys_tenant SET deleted_at=UTC_TIMESTAMP(3) WHERE id=?',
      [id],
    );
    expect(await source.byDomain('demo.example.com:8851')).toBeNull();
  });
  it('迁移up/down只作用于两张新表，活动编码唯一，软删除后可复用', async () => {
    const runner = ds.createQueryRunner();
    await runner.connect();
    try {
      await runner.dropTable('sys_tenant');
      await runner.dropTable('sys_package');
      const migration = new TenantCatalog1794412800000();
      await migration.up(runner);
      const { id, pack } = await seed();
      await expect(
        context.run({ tenantId: '0' }, () =>
          repos.for(SystemTenant).insert({
            code: 'demo',
            name: '重复编码',
            packageId: pack,
            domains: [],
            enabled: true,
          }),
        ),
      ).rejects.toThrow();
      await ds.query(
        'UPDATE sys_tenant SET deleted_at=UTC_TIMESTAMP(3) WHERE id=?',
        [id],
      );
      await context.run({ tenantId: '0' }, () =>
        repos.for(SystemTenant).insert({
          code: 'demo',
          name: '复用编码',
          packageId: '1',
          domains: [],
          enabled: true,
        }),
      );
      await migration.down(runner);
      expect(await runner.hasTable('sys_tenant')).toBe(false);
      expect(await runner.hasTable('sys_package')).toBe(false);
      expect(await runner.hasTable('sys_user')).toBe(true);
      await migration.up(runner);
    } finally {
      await runner.release();
    }
  });
});
