import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { SystemDirectory } from '../src/modules/system/service/system-directory.service.js';
import { RequestContext } from '../src/core/tenant/request-context.js';
import { createTestModule } from './support/test-auth.js';
import { clearTestRedis, rawRedis } from './support/test-redis.js';

describe('T07系统管理与组织失效（统一测试阶段执行）', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  beforeAll(async () => {
    const module = await createTestModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    expect(String(ds.options.database)).toMatch(/_test$/);
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    if (!String(ds.options.database).endsWith('_test'))
      throw new Error('拒绝清理非测试库');
    for (const table of [
      'sys_user_supervisor',
      'sys_user_role',
      'sys_menu',
      'sys_role',
      'sys_org',
      'sys_user',
    ])
      await ds.query(`DELETE FROM ${table}`);
    const redis = rawRedis();
    try {
      await clearTestRedis(redis);
    } finally {
      await redis.quit();
    }
  });
  const post = (path: string, body: object, tenant = '1') =>
    request(app.getHttpServer())
      .post('/admin/system/' + path)
      .set('x-test-user', '999999')
      .set('x-test-tenant', tenant)
      .send(body);
  const user = async (name: string) =>
    (
      await post('user/create', {
        username: name,
        nickname: name,
        password: 'StrongPassword8',
      }).expect(200)
    ).body.data.id as string;

  it('密码不进详情；跨租户404；重置要求当前版本且不接受旧版本', async () => {
    const id = await user('alice');
    const detail = await post('user/info', { id }).expect(200);
    expect(detail.body.data).not.toHaveProperty('passwordHash');
    await post('user/info', { id }, '2').expect(404);
    await post('user/reset-password', {
      id,
      version: detail.body.data.version,
      password: 'AnotherPassword9',
    }).expect(200);
    await post('user/reset-password', {
      id,
      version: detail.body.data.version,
      password: 'WrongVersion8',
    }).expect(409);
    await post('user/reset-password', {
      id,
      version: detail.body.data.version + 1,
      password: '123456',
    }).expect(400);
  });

  it('停用父组织后，原分配与可切换组织同时失效', async () => {
    const id = await user('bob');
    const org = (
      await post('org/add', {
        data: { name: '组织', parentId: null, enabled: true, rank: 0 },
      }).expect(200)
    ).body.data;
    const role = (
      await post('role/add', {
        data: {
          code: 'editor',
          name: '编辑',
          enabled: true,
          permissions: ['system:user:page'],
          dataScope: 'org',
          customOrgIds: [],
        },
      }).expect(200)
    ).body.data;
    await post('user-role/add', {
      data: { userId: id, roleId: role.id, scopeOrgId: org.id },
    }).expect(200);
    const context = app.get(RequestContext),
      directory = app.get(SystemDirectory);
    expect(
      await context.run({ tenantId: '1' }, () => directory.grants('1', id)),
    ).toHaveLength(1);
    await post('org/update', {
      id: org.id,
      version: org.version,
      data: { enabled: false },
    }).expect(200);
    expect(
      await context.run({ tenantId: '1' }, () => directory.grants('1', id)),
    ).toEqual([]);
    expect(
      await context.run({ tenantId: '1' }, () => directory.userOrgs('1', id)),
    ).toEqual([]);
  });

  it('组织不能移到下级，多上级关系不能形成环', async () => {
    const root = (
      await post('org/add', {
        data: { name: '根', parentId: null, enabled: true, rank: 0 },
      }).expect(200)
    ).body.data;
    const child = (
      await post('org/add', {
        data: { name: '子', parentId: root.id, enabled: true, rank: 0 },
      }).expect(200)
    ).body.data;
    await post('org/update', {
      id: root.id,
      version: root.version,
      data: { parentId: child.id },
    }).expect(400);
    const a = await user('user.a'),
      b = await user('user.b'),
      c = await user('user.c');
    await post('user-supervisor/add', {
      data: { userId: a, supervisorId: b },
    }).expect(200);
    await post('user-supervisor/add', {
      data: { userId: b, supervisorId: c },
    }).expect(200);
    await post('user-supervisor/add', {
      data: { userId: c, supervisorId: a },
    }).expect(400);
  });
});
