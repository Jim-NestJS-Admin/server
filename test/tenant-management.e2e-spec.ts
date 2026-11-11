import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AdminAuth } from '../src/core/endpoint/endpoint-auth.js';
import { RequestContext } from '../src/core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../src/core/tenant/tenant-repository.js';
import { TenantSource } from '../src/core/tenant/tenant-source.js';
import {
  SystemTenant,
  TenantPackage,
  TenantQuotas,
} from '../src/modules/tenant/entity/tenant.entity.js';
import { SystemMenu } from '../src/modules/system/entity/system.entity.js';
import { SystemTenantService } from '../src/modules/system/service/system-tenant.service.js';
import { PermissionRegistry } from '../src/core/permission/permission-registry.js';
import { BlobStore } from '../src/modules/file/storage/blob-store.js';
import { TestAdminAuth } from './support/test-auth.js';
import { clearTestRedis, rawRedis } from './support/test-redis.js';
import { buildOpenApiDocument } from '../src/core/swagger/swagger.js';
import { TenantSeedService } from '../src/modules/tenant/service/tenant-seed.service.js';
import { PlatformMenus1794412800001 } from '../src/database/migrations/1794412800001-PlatformMenus.js';
import { FileAssetEntity } from '../src/modules/file/entity/file-asset.entity.js';

/** 只替换HTTP登录取身份的入口；租户目录、真实系统角色/菜单/套餐/配额均不替换。 */
describe('T31 平台租户管理、初始化与事务配额', () => {
  let app: INestApplication<App>,
    ds: DataSource,
    context: RequestContext,
    repos: TenantRepositoryFactory,
    system: SystemTenantService;
  let platformUser: string,
    tenantUser: string,
    allMenus: string[],
    allPackage: string;
  const blobs = new Map<string, Buffer>();
  const store: BlobStore = {
    put: async (key, data) => {
      blobs.set(key, data);
    },
    get: async (key) => blobs.get(key)!,
    discard: async (key) => {
      blobs.delete(key);
    },
  };
  const http = (
    path: string,
    body: object = {},
    tenant = '0',
    user = platformUser,
  ) =>
    request(app.getHttpServer())
      .post('/admin/' + path)
      .set('x-test-tenant', tenant)
      .set('x-test-user', user)
      .send(body);
  const get = (path: string, tenant = '0', user = platformUser) =>
    request(app.getHttpServer())
      .get('/admin/' + path)
      .set('x-test-tenant', tenant)
      .set('x-test-user', user);
  const pack = async (quotas: Partial<TenantQuotas> = {}) =>
    (
      await http('platform/package/add', {
        data: {
          code: 'basic',
          name: '基础版',
          enabled: true,
          menuIds: allMenus,
          quotas: Object.assign(new TenantQuotas(), quotas),
        },
      }).expect(200)
    ).body.data;
  const tenantBody = (packageId: string, code = 'demo') => ({
    data: {
      code,
      name: '演示租户',
      packageId,
      domains: [code + '.example.test'],
      enabled: true,
    },
    adminUsername: 'admin',
    adminPassword: 'StrongPassword8',
  });
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AdminAuth)
      .useClass(TestAdminAuth)
      .overrideProvider(BlobStore)
      .useValue(store)
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    context = app.get(RequestContext);
    repos = app.get(TenantRepositoryFactory);
    system = app.get(SystemTenantService);
    if (ds.options.database !== 'jim_admin_integration_20261109_test')
      throw Error('仅允许指定独立测试库');
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    if (ds.options.database !== 'jim_admin_integration_20261109_test')
      throw Error('拒绝清理其他库');
    for (const table of [
      'sys_user_role',
      'sys_user_supervisor',
      'sys_user',
      'sys_role',
      'sys_org',
      'sys_menu',
      'file_asset',
      'sys_operation_log',
    ])
      await ds.query(`DELETE FROM ${table}`);
    await ds.query('TRUNCATE TABLE sys_tenant');
    await ds.query('TRUNCATE TABLE sys_package');
    const redis = rawRedis();
    try {
      await clearTestRedis(redis);
    } finally {
      await redis.quit();
    }
    blobs.clear();
    const hash = await system.passwordHash('StrongPassword8');
    await context.run({ tenantId: '0' }, () =>
      ds.transaction(async (manager) => {
        const root = await repos.for(SystemMenu).insert(
          {
            scope: 'tenant',
            type: 'directory',
            path: '/system',
            title: '系统',
            parentId: null,
            icon: null,
            rank: 0,
            component: null,
            permission: null,
            hidden: false,
            keepAlive: false,
          },
          manager,
        );
        const page = await repos.for(SystemMenu).insert(
          {
            scope: 'tenant',
            type: 'page',
            path: '/system/user',
            title: '用户',
            parentId: root,
            component: 'system/user',
            permission: 'system:user:page',
            rank: 0,
            hidden: false,
            keepAlive: false,
          },
          manager,
        );
        allMenus = [root, page];
        for (const permission of app
          .get(PermissionRegistry)
          .all()
          .map((item) => item.code)
          .filter(
            (code) =>
              !code.startsWith('platform:') &&
              !code.startsWith('system:menu:') &&
              code !== 'system:user:page',
          ))
          allMenus.push(
            await repos.for(SystemMenu).insert(
              {
                scope: 'tenant',
                type: 'button',
                path: '',
                title: permission,
                parentId: page,
                permission,
                rank: 0,
                hidden: false,
                keepAlive: false,
              },
              manager,
            ),
          );
        await repos.for(SystemMenu).insert(
          {
            scope: 'platform',
            type: 'page',
            path: '/platform/tenant',
            component: 'platform/tenant',
            title: '租户',
            parentId: null,
            permission: 'platform:tenant:page',
            rank: 0,
            hidden: false,
            keepAlive: false,
          },
          manager,
        );
        allPackage = await repos.for(TenantPackage).insert(
          {
            code: 'all',
            name: '全部',
            enabled: true,
            menuIds: allMenus,
            quotas: new TenantQuotas(),
          },
          manager,
        );
        const id = await repos.for(SystemTenant).insert(
          {
            code: 'default',
            name: '默认租户',
            packageId: allPackage,
            domains: [],
            enabled: true,
            expiresAt: null,
          },
          manager,
        );
        expect(id).toBe('1');
        platformUser = (
          await system.initialize(
            manager,
            '平台',
            'admin',
            hash,
            'platform_admin',
          )
        ).userId;
      }),
    );
    tenantUser = await context.run({ tenantId: '1' }, () =>
      ds.transaction(
        async (manager) =>
          (await system.initialize(manager, '默认组织', 'admin', hash)).userId,
      ),
    );
  });
  it('schema和OpenAPI保留新增能力及固定operationId，套餐菜单树含按钮且无平台菜单', async () => {
    const schema = (await get('platform/tenant/schema').expect(200)).body.data;
    expect(schema.api).toContain('add');
    expect(schema.actions.add.writable).toContain('packageId');
    const menus = (await http('platform/package/menus').expect(200)).body.data;
    expect(
      menus[0].children[0].children.some(
        (menu: { type: string }) => menu.type === 'button',
      ),
    ).toBe(true);
    expect(JSON.stringify(menus)).not.toContain('platform:tenant:page');
    const doc = buildOpenApiDocument(app, 'test');
    expect(doc.paths['/admin/platform/tenant/add'].post?.operationId).toBe(
      'platformTenantAdd',
    );
    expect(doc.paths['/admin/platform/package/menus'].post?.operationId).toBe(
      'platformPackageMenus',
    );
  });
  it('创建租户与组织/超管角色/账号同事务完成，密码不外露，概况只读且有持久化审计', async () => {
    const p = await pack({ maxUsers: 5 });
    const created = (
      await http('platform/tenant/add', tenantBody(p.id)).expect(200)
    ).body.data;
    expect(created.id).not.toBe('1');
    expect(JSON.stringify(created)).not.toMatch(/StrongPassword|passwordHash/);
    const [users] = await ds.query(
      'SELECT COUNT(*) count FROM sys_user WHERE tenant_id=?',
      [created.id],
    );
    expect(Number(users.count)).toBe(1);
    const usage = (
      await http('platform/tenant/usage', { id: created.id }).expect(200)
    ).body.data;
    expect(usage).toMatchObject({
      tenantId: created.id,
      users: 1,
      storageBytes: '0',
      quotas: { maxUsers: 5 },
    });
    const [audit] = await ds.query(
      "SELECT COUNT(*) count FROM sys_operation_log WHERE tenant_id=0 AND action='platform:cross-tenant-read'",
    );
    expect(Number(audit.count)).toBeGreaterThan(0);
    expect(await app.get(TenantSource).byCode('demo')).toMatchObject({
      id: created.id,
      enabled: true,
    });
  });
  it('密码策略错误定位adminPassword，初始化失败回滚租户，弱口令不创建记录', async () => {
    const p = await pack();
    const response = await http('platform/tenant/add', {
      ...tenantBody(p.id),
      adminPassword: '123456',
    }).expect(400);
    expect(
      response.body.data.errors.some(
        (error: { field: string }) => error.field === 'adminPassword',
      ),
    ).toBe(true);
    const initialize = vi
      .spyOn(system, 'initialize')
      .mockRejectedValueOnce(new Error('模拟初始化失败'));
    await http('platform/tenant/add', tenantBody(p.id)).expect(500);
    initialize.mockRestore();
    const [rows] = await ds.query('SELECT COUNT(*) count FROM sys_tenant');
    expect(Number(rows.count)).toBe(1);
  });
  it('域名并发竞争只成功一个，归一化后全局唯一；停用套餐不可新分配但不影响已有租户', async () => {
    const p = await pack();
    const a = tenantBody(p.id, 'tenant-a'),
      b = tenantBody(p.id, 'tenant-b');
    a.data.domains = ['SHARED.EXAMPLE.TEST:80'];
    b.data.domains = ['shared.example.test'];
    const results = await Promise.all([
      http('platform/tenant/add', a),
      http('platform/tenant/add', b),
    ]);
    expect(
      results.map((result) => result.status).sort((a, b) => a - b),
    ).toEqual([200, 400]);
    const winner = results.find((result) => result.status === 200)!.body.data;
    await http('platform/package/update', {
      id: p.id,
      version: p.version,
      data: { enabled: false },
    }).expect(200);
    expect(await app.get(TenantSource).packageMenuIds(winner.id)).toEqual(
      expect.arrayContaining(allMenus),
    );
    await http('platform/tenant/add', tenantBody(p.id, 'disabled-pack')).expect(
      400,
    );
    await http('platform/package/delete', { ids: [p.id] }).expect(400);
  });
  it('普通租户不能访问平台接口或菜单管理，也不能授予套餐外/平台权限', async () => {
    for (const path of [
      'platform/tenant/page',
      'platform/package/menus',
      'system/menu/page',
    ])
      await http(path, {}, '1', tenantUser).expect(403);
    await http(
      'system/role/add',
      {
        data: {
          code: 'forbidden-role',
          name: '越权',
          enabled: true,
          permissions: ['platform:tenant:page'],
          dataScope: 'all',
          customOrgIds: [],
        },
      },
      '1',
      tenantUser,
    ).expect(400);
  });
  it('并发新增用户在同事务锁租户后只允许剩余一个名额', async () => {
    const p = await pack({ maxUsers: 2 });
    const t = (await http('platform/tenant/add', tenantBody(p.id)).expect(200))
      .body.data;
    const [admin] = await ds.query(
      'SELECT id FROM sys_user WHERE tenant_id=?',
      [t.id],
    );
    const results = await Promise.all(
      ['user-a', 'user-b'].map((username) =>
        http(
          'system/user/create',
          { username, nickname: username, password: 'StrongPassword8' },
          t.id,
          admin.id,
        ),
      ),
    );
    expect(
      results.map((result) => result.status).sort((a, b) => a - b),
    ).toEqual([200, 400]);
    expect(
      results.find((result) => result.status === 400)!.body.message,
    ).toContain('用户数上限');
    const [count] = await ds.query(
      'SELECT COUNT(*) count FROM sys_user WHERE tenant_id=?',
      [t.id],
    );
    expect(Number(count.count)).toBe(2);
  });
  it('存储配额在写元数据事务检查，失败清理本次对象', async () => {
    const p = await pack({ storageMb: 0 });
    const t = (await http('platform/tenant/add', tenantBody(p.id)).expect(200))
      .body.data;
    const [admin] = await ds.query(
      'SELECT id FROM sys_user WHERE tenant_id=?',
      [t.id],
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
      'base64',
    );
    await request(app.getHttpServer())
      .post('/admin/file/asset/upload')
      .set('x-test-tenant', t.id)
      .set('x-test-user', admin.id)
      .attach('file', png, 'probe.png')
      .expect(400);
    expect(blobs.size).toBe(0);
    const [count] = await ds.query(
      'SELECT COUNT(*) count FROM file_asset WHERE tenant_id=?',
      [t.id],
    );
    expect(Number(count.count)).toBe(0);
  });
  it('部分更新不重置域名/启用值，软删除立即停用目录且不物理删除业务数据', async () => {
    const p = await pack(),
      created = (
        await http('platform/tenant/add', tenantBody(p.id)).expect(200)
      ).body.data;
    const disabled = (
      await http('platform/tenant/update', {
        id: created.id,
        version: created.version,
        data: { enabled: false },
      }).expect(200)
    ).body.data;
    const renamed = (
      await http('platform/tenant/update', {
        id: created.id,
        version: disabled.version,
        data: { name: '新名称' },
      }).expect(200)
    ).body.data;
    expect(renamed.enabled).toBe(false);
    expect(renamed.domains).toEqual(['demo.example.test']);
    await http('platform/tenant/delete', { ids: [created.id] }).expect(200);
    expect(await app.get(TenantSource).byId(created.id)).toBeNull();
    const [userCount] = await ds.query(
      'SELECT COUNT(*) count FROM sys_user WHERE tenant_id=?',
      [created.id],
    );
    expect(Number(userCount.count)).toBe(1);
  });
  it('并发文件上传只占用剩余一个名额，失败请求不遗留新对象', async () => {
    const p = await pack({ storageMb: 1 }),
      t = (await http('platform/tenant/add', tenantBody(p.id)).expect(200)).body
        .data;
    const [admin] = await ds.query(
      'SELECT id FROM sys_user WHERE tenant_id=?',
      [t.id],
    );
    // 独立测试库中的已有用量夹具；本用例只验证配额事务，不下载此夹具。
    await context.run({ tenantId: t.id }, () =>
      repos.for(FileAssetEntity).insert({
        name: 'fixture.png',
        mime: 'image/png',
        bytes: 1048576 - 67,
        objectKey: `tenants/${t.id}/00000000-0000-4000-8000-000000000000.png`,
        sha256: '0'.repeat(64),
      }),
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
      'base64',
    );
    expect(png.length).toBe(67);
    const responses = await Promise.all(
      [1, 2].map(() =>
        request(app.getHttpServer())
          .post('/admin/file/asset/upload')
          .set('x-test-tenant', t.id)
          .set('x-test-user', admin.id)
          .attach('file', png, 'probe.png'),
      ),
    );
    expect(
      responses.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([200, 400]);
    expect(blobs.size).toBe(1);
  });
  it('seed可重复执行，保留现有账号密码，登记默认租户与demo及基础配额', async () => {
    const before = await ds.query(
      'SELECT id,password_hash FROM sys_user ORDER BY id',
    );
    const hash = await system.passwordHash('DifferentPassword9');
    for (let count = 0; count < 2; count++)
      await context.run({ tenantId: '0', userId: platformUser }, () =>
        ds.transaction((manager) =>
          app.get(TenantSeedService).seed(manager, hash),
        ),
      );
    const after = await ds.query(
      'SELECT id,password_hash FROM sys_user ORDER BY id',
    );
    for (const user of before)
      expect(
        after.find((row: { id: string }) => row.id === user.id).password_hash,
      ).toBe(user.password_hash);
    expect(after).toHaveLength(before.length + 1);
    const demo = await app.get(TenantSource).byCode('demo');
    expect(demo?.id).not.toBe('1');
    const [basic] = await ds.query(
      'SELECT quotas FROM sys_package WHERE code=?',
      ['basic'],
    );
    const quotas =
      typeof basic.quotas === 'string'
        ? JSON.parse(basic.quotas)
        : basic.quotas;
    expect(quotas.maxUsers).toBe(5);
  });
  it('菜单迁移保留原页面/按钮编号并移归平台，回退要求备份而非盲改新数据', async () => {
    await ds.query('DELETE FROM sys_menu');
    const original = await context.run({ tenantId: '1' }, async () => {
      const root = await repos.for(SystemMenu).insert({
        scope: 'tenant',
        type: 'directory',
        path: '/system',
        title: '系统',
        parentId: null,
        rank: 0,
        hidden: false,
        keepAlive: false,
      });
      const menu = await repos.for(SystemMenu).insert({
        scope: 'tenant',
        type: 'page',
        path: '/system/menu',
        component: 'system/menu',
        permission: 'system:menu:page',
        title: '菜单',
        parentId: root,
        rank: 0,
        hidden: false,
        keepAlive: false,
      });
      const button = await repos.for(SystemMenu).insert({
        scope: 'tenant',
        type: 'button',
        path: '',
        title: '删除',
        parentId: menu,
        permission: 'system:menu:delete',
        rank: 0,
        hidden: false,
        keepAlive: false,
      });
      return { menu, button };
    });
    await ds.query('ALTER TABLE sys_menu DROP COLUMN scope');
    const runner = ds.createQueryRunner();
    await runner.connect();
    try {
      const migration = new PlatformMenus1794412800001();
      await migration.up(runner);
      const existing = await ds.query(
        'SELECT id,tenant_id,scope FROM sys_menu WHERE id IN (?,?)',
        [original.menu, original.button],
      );
      expect(existing).toHaveLength(2);
      expect(
        existing.every(
          (row: { tenant_id: string; scope: string }) =>
            row.tenant_id === '0' && row.scope === 'platform',
        ),
      ).toBe(true);
      const pages = await ds.query(
        "SELECT component FROM sys_menu WHERE path IN ('/platform/tenant','/platform/package') ORDER BY path",
      );
      expect(pages.map((row: { component: string }) => row.component)).toEqual([
        'platform/package',
        'platform/tenant',
      ]);
      await expect(migration.down(runner)).rejects.toThrow('备份');
    } finally {
      await runner.release();
    }
  });
});
