import type { INestApplication } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { FileModule } from '../src/modules/file/file.module.js';
import { BlobStore } from '../src/modules/file/storage/blob-store.js';
import { RequestContext } from '../src/core/tenant/request-context.js';
import { createTestModule } from './support/test-auth.js';
import { clearTestRedis, rawRedis } from './support/test-redis.js';
import {
  DemoOrderController,
  DemoOrderEntity,
  DemoOrderItemEntity,
  DemoOrderNoteEntity,
  DemoOrderTagEntity,
} from './fixtures/demo-order.js';

type Row = { id: string; version: number; [key: string]: unknown };
const directions = [
  ['1', '2'],
  ['2', '1'],
] as const;
const entities = [
  DemoOrderEntity,
  DemoOrderItemEntity,
  DemoOrderNoteEntity,
  DemoOrderTagEntity,
];

/** T32第一批：真实资源、真实数据库/Redis；仅替换登录和角色来源，不跳过字段/查询/仓库隔离。 */
describe('T32 现有资源跨租户双向防漏', () => {
  let app: INestApplication<App>, ds: DataSource;
  const blobs = new Map<string, Buffer>();
  const store: BlobStore = {
    put: async (key, data) => {
      blobs.set(key, data);
    },
    get: async (key) => {
      const data = blobs.get(key);
      if (!data) throw new Error('对象不存在');
      return data;
    },
    discard: async (key) => {
      blobs.delete(key);
    },
  };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
    'base64',
  );
  const headers = (tenant: string, req: request.Test) =>
    req.set('x-test-tenant', tenant).set('x-test-user', '999999');
  const post = (tenant: string, path: string, body: object = {}) =>
    headers(tenant, request(app.getHttpServer()).post('/admin/' + path)).send(
      body,
    );
  const get = (tenant: string, path: string) =>
    headers(tenant, request(app.getHttpServer()).get('/admin/' + path));
  const add = async (tenant: string, resource: string, data: object) =>
    (await post(tenant, resource + '/add', { data }).expect(200)).body
      .data as Row;

  beforeAll(async () => {
    const module = await createTestModule({
      imports: [
        AppModule,
        TypeOrmModule.forFeature(entities),
        FileModule.register({
          store,
          policy: { maxBytes: 512, mimeTypes: ['image/png'] },
          catalog: 'database',
          access: {
            current: async () => {
              const ctx = app.get(RequestContext).current();
              return { tenantId: ctx.tenantId, userId: ctx.userId! };
            },
          },
        }),
      ],
      controllers: [DemoOrderController],
    })
      .overrideProvider(BlobStore)
      .useValue(store)
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    if (ds.options.database !== 'jim_admin_integration_20261109_test')
      throw new Error('T32只允许指定独立测试库');
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    if (ds.options.database !== 'jim_admin_integration_20261109_test')
      throw new Error('拒绝清理其他库');
    for (const table of [
      'demo_order_tag',
      'demo_order_note',
      'demo_order_item',
      'demo_order',
      'sys_role_field',
      'sys_field',
      'sys_page_config_history',
      'sys_page_config',
      'sys_user_pref',
      'sys_user_supervisor',
      'sys_user_role',
      'sys_user',
      'sys_role',
      'sys_org',
      'sys_dict_item',
      'sys_dict_type',
      'sys_parameter',
      'file_asset',
    ])
      await ds.query(`DELETE FROM ${table}`);
    const redis = rawRedis();
    try {
      await clearTestRedis(redis);
    } finally {
      await redis.quit();
    }
    blobs.clear();
  });

  const resources = [
    {
      resource: 'system/org',
      field: 'name',
      data: (tenant: string) => ({
        name: `组织-${tenant}`,
        parentId: null,
        enabled: true,
        rank: 0,
      }),
      update: { name: '越租户修改' },
    },
    {
      resource: 'system/role',
      field: 'name',
      data: (tenant: string) => ({
        code: 'same-role',
        name: `角色-${tenant}`,
        enabled: true,
        permissions: ['system:user:page'],
        dataScope: 'all',
        customOrgIds: [],
      }),
      update: { name: '越租户修改' },
    },
    {
      resource: 'system/dict-type',
      field: 'name',
      data: (tenant: string) => ({
        code: 'same.status',
        name: `字典-${tenant}`,
        enabled: true,
        builtin: false,
      }),
      update: { name: '越租户修改' },
    },
    {
      resource: 'system/parameter',
      field: 'value',
      data: (tenant: string) => ({ key: 'same.key', value: `参数-${tenant}` }),
      update: { value: '越租户修改' },
    },
  ];
  for (const [attacker, owner] of directions) {
    describe(`${attacker} → ${owner}`, () => {
      it.each(resources)(
        '$resource 的列表、详情、修改、删除、导出不泄露其他租户',
        async ({ resource, field, data, update }) => {
          const own = await add(attacker, resource, data(attacker));
          const foreign = await add(owner, resource, data(owner));
          const page = (await post(attacker, resource + '/page').expect(200))
            .body.data;
          expect(page.list.map((row: Row) => row.id)).toEqual([own.id]);
          const missing = (
            await post(attacker, resource + '/info', {
              id: '99999999999999',
            }).expect(404)
          ).body;
          expect(
            (
              await post(attacker, resource + '/info', {
                id: foreign.id,
              }).expect(404)
            ).body,
          ).toEqual(missing);
          await post(attacker, resource + '/update', {
            id: foreign.id,
            version: foreign.version,
            data: update,
          }).expect(404);
          await post(attacker, resource + '/delete', {
            ids: [foreign.id],
          }).expect(404);
          const after = (
            await post(owner, resource + '/info', { id: foreign.id }).expect(
              200,
            )
          ).body.data;
          expect(after.version).toBe(foreign.version);
          expect(after[field]).toBe(
            data(owner)[field as keyof ReturnType<typeof data>],
          );
          const csv = (
            await post(attacker, resource + '/export', {
              format: 'csv',
            }).expect(200)
          ).text;
          expect(csv).toContain(String(own[field]));
          expect(csv).not.toContain(String(foreign[field]));
          if (resource === 'system/org')
            expect(
              (
                await post(attacker, resource + '/tree').expect(200)
              ).body.data.list.map((row: Row) => row.id),
            ).toEqual([own.id]);
        },
      );

      it('用户同名可分别创建，跨租户重置密码/引用组织失败且原版本不变', async () => {
        const create = async (tenant: string) =>
          (
            await post(tenant, 'system/user/create', {
              username: 'same-user',
              nickname: '同名用户',
              password: 'StrongPassword8',
            }).expect(200)
          ).body.data as Row;
        const ownCreated = await create(attacker),
          foreignCreated = await create(owner);
        const own = (
          await post(attacker, 'system/user/info', {
            id: ownCreated.id,
          }).expect(200)
        ).body.data as Row;
        const foreign = (
          await post(owner, 'system/user/info', {
            id: foreignCreated.id,
          }).expect(200)
        ).body.data as Row;
        expect(
          (
            await post(attacker, 'system/user/page').expect(200)
          ).body.data.list.map((row: Row) => row.id),
        ).toEqual([own.id]);
        await post(attacker, 'system/user/reset-password', {
          id: foreign.id,
          version: foreign.version,
          password: 'AnotherPassword9',
        }).expect(404);
        await post(attacker, 'system/user/update', {
          id: foreign.id,
          version: foreign.version,
          data: { nickname: '越权' },
        }).expect(404);
        await post(attacker, 'system/user/delete', {
          ids: [foreign.id],
        }).expect(404);
        const org = await add(owner, 'system/org', {
          name: '外租户组织',
          parentId: null,
          enabled: true,
          rank: 0,
        });
        await post(attacker, 'system/user/update', {
          id: own.id,
          version: own.version,
          data: { defaultOrgId: org.id },
        }).expect(400);
        expect(
          (
            await post(owner, 'system/user/info', { id: foreign.id }).expect(
              200,
            )
          ).body.data.version,
        ).toBe(foreign.version);
      });

      it('主子表不能换成其他租户的子行，回收站/恢复/彻底删除均隔离', async () => {
        const order = async (tenant: string) =>
          (
            await post(tenant, 'test/demo-order/add', {
              data: { orderNo: 'same-order', title: '订单' },
              children: {
                items: {
                  added: [{ clientId: 'line', productCode: 'P1', qty: 1 }],
                },
              },
            }).expect(200)
          ).body.data;
        const own = await order(attacker),
          foreign = await order(owner);
        await post(attacker, 'test/demo-order/update', {
          id: own.id,
          version: own.version,
          data: {},
          children: {
            items: { updated: [{ id: foreign.children.items[0].id, qty: 9 }] },
          },
        }).expect(400);
        expect(
          (
            await post(attacker, 'test/demo-order/info', { id: own.id }).expect(
              200,
            )
          ).body.data.version,
        ).toBe(own.version);
        await post(owner, 'test/demo-order/delete', {
          ids: [foreign.id],
        }).expect(200);
        const recycle = (
          await post(owner, 'test/demo-order/recycle/page').expect(200)
        ).body.data.list[0];
        expect(
          (await post(attacker, 'test/demo-order/recycle/page').expect(200))
            .body.data.total,
        ).toBe(0);
        for (const action of ['restore', 'purge'])
          await post(attacker, 'test/demo-order/' + action, {
            items: [{ id: foreign.id, version: recycle.version }],
          }).expect(404);
        await post(owner, 'test/demo-order/restore', {
          items: [{ id: foreign.id, version: recycle.version }],
        }).expect(200);
      });

      it('同一用户/组织的个人偏好和常用查询仍按租户隔离', async () => {
        const key = 'query:system:user';
        await post(owner, 'session/preference/save', {
          key,
          value: { name: '另一租户查询' },
        }).expect(200);
        expect(
          (await get(attacker, 'session/preference?key=' + key).expect(200))
            .body.data.value,
        ).toBeNull();
        await post(attacker, 'session/preference/save', {
          key,
          value: { name: '自己查询' },
        }).expect(200);
        await post(attacker, 'session/preference/delete', { key }).expect(200);
        expect(
          (await get(owner, 'session/preference?key=' + key).expect(200)).body
            .data.value,
        ).toEqual({ name: '另一租户查询' });
      });

      it('模块配置、历史内容、字段默认与角色字段权限的编号不能跨租户使用', async () => {
        await post(owner, 'system/page-config/save', {
          resource: 'system:user',
          version: 0,
          config: { list: { pageSize: 30 } },
        }).expect(200);
        expect(
          (
            await get(
              attacker,
              'system/page-config?resource=system:user',
            ).expect(200)
          ).body.data.version,
        ).toBe(0);
        const history = (
          await post(owner, 'system/page-config/history', {
            resource: 'system:user',
          }).expect(200)
        ).body.data.list[0];
        await post(attacker, 'system/page-config/history-info', {
          resource: 'system:user',
          historyId: history.id,
        }).expect(404);
        const field = await add(owner, 'system/field', {
          resource: 'system:user',
          field: 'nickname',
          state: 'readonly',
          enabled: true,
        });
        await post(attacker, 'system/field/info', { id: field.id }).expect(404);
        await post(attacker, 'system/field/update', {
          id: field.id,
          version: field.version,
          data: { state: 'hidden' },
        }).expect(404);
        const role = await add(owner, 'system/role', {
          code: 'foreign-role',
          name: '其他租户角色',
          enabled: true,
          permissions: ['system:user:page'],
          dataScope: 'all',
          customOrgIds: [],
        });
        await post(attacker, 'system/role-field/add', {
          data: {
            roleId: role.id,
            resource: 'system:user',
            field: 'nickname',
            state: 'hidden',
          },
        }).expect(400);
        const schema = (await get(attacker, 'system/user/schema').expect(200))
          .body.data;
        expect(schema.moduleView.list.pageSize).toBe(20);
      });

      it('文件上传归属当前租户，其他租户无法详情、下载或枚举对象键', async () => {
        const upload = await headers(
          owner,
          request(app.getHttpServer()).post('/admin/file/asset/upload'),
        )
          .attach('file', png, 'probe.png')
          .expect(200);
        const id = upload.body.data.id;
        await post(attacker, 'file/asset/info', { id }).expect(404);
        await post(attacker, 'file/asset/download', { id }).expect(404);
        expect(
          (await post(attacker, 'file/asset/page').expect(200)).body.data.total,
        ).toBe(0);
        expect(
          (await post(owner, 'file/asset/info', { id }).expect(200)).body.data,
        ).not.toHaveProperty('objectKey');
        expect([...blobs.keys()][0]).toMatch(new RegExp(`^tenants/${owner}/`));
      });
    });
  }

  it.skip('待T30：真实令牌绑定域名、刷新与切换组织双向隔离', () => {});
  it.skip('待T30：验证码换租户、停用/过期立即使真实会话失效且登录错误不泄露租户', () => {});
  it.skip('待T30/T31：平台只读审计与租户拒绝访问平台/菜单管理', () => {});
  it.skip('待T31：套餐外及platform权限不可授予，配额并发不超限', () => {});
});
