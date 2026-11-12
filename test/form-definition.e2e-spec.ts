import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PermissionSource } from '../src/core/permission/permission-source.js';
import { RequestContext } from '../src/core/tenant/request-context.js';
import { FormDefinitionService } from '../src/modules/form/service/form-definition.service.js';
import { FormDefinition1794470400000 } from '../src/database/migrations/1794470400000-FormDefinition.js';
import { buildOpenApiDocument } from '../src/core/swagger/swagger.js';
import { createTestModule } from './support/test-auth.js';
import { assertTestDatabase } from './support/test-database.js';
import { clearTestRedis, rawRedis } from './support/test-redis.js';

describe('T35 表单版本、校验与租户边界', () => {
  let app: INestApplication<App>, ds: DataSource;
  beforeAll(async () => {
    const module = await createTestModule({ imports: [AppModule] })
      .overrideProvider(PermissionSource)
      .useValue({
        loadGrants: async (_tenant: string, user: string) =>
          user === '2'
            ? []
            : [
                {
                  roleId: 'form-admin',
                  scopeOrgId: null,
                  permissions: user === '3' ? ['form:definition:info'] : [],
                  allPermissions: user !== '3',
                  dataScope: 'all',
                },
              ],
        loadOrgs: async () => [],
        loadMenus: async () => [],
      })
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    assertTestDatabase(ds.options.database, process.env.DB_NAME);
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    assertTestDatabase(ds.options.database, process.env.DB_NAME);
    await ds.query('DELETE FROM form_definition');
    const redis = rawRedis();
    try {
      await clearTestRedis(redis);
    } finally {
      await redis.quit();
    }
  });
  const post = (path: string, body: object, tenant = '1', user = '1') =>
    request(app.getHttpServer())
      .post('/admin/form/definition/' + path)
      .set('x-test-user', user)
      .set('x-test-tenant', tenant)
      .send(body);
  const data = (required = false) => ({
    code: 'leave_request',
    name: '请假申请',
    designer: {
      schemaVersion: 1,
      rule: [
        { type: 'input', field: 'reason', title: '原因', $required: required },
      ],
    },
  });
  const add = async (tenant = '1', required = false) =>
    (await post('add', { data: data(required) }, tenant).expect(200)).body
      .data as {
      id: string;
      revision: number;
      designer: object;
      fields: object[];
    };

  it('正式迁移up/down/up可执行，字段与唯一索引可供实体使用', async () => {
    const runner = ds.createQueryRunner();
    const migration = new FormDefinition1794470400000();
    try {
      await migration.down(runner);
      await migration.up(runner);
      const table = await runner.getTable('form_definition');
      expect(
        table?.columns.find((c) => c.name === 'active_guard')?.asExpression,
      ).toBeTruthy();
      expect(
        table?.indices.find((i) => i.name === 'uk_form_definition_revision')
          ?.columnNames,
      ).toEqual(['tenant_id', 'code', 'revision', 'active_guard']);
      const first = await add();
      expect(first.revision).toBe(1);
    } finally {
      await runner.release();
    }
  });

  it('创建快照、解析字段并拒绝额外系统字段和伪造字段清单', async () => {
    const first = await add();
    expect(first).toMatchObject({
      revision: 1,
      fields: [{ field: 'reason', type: 'string' }],
    });
    expect(first).not.toHaveProperty('tenantId');
    const res = await post('inspect', { designer: data(true).designer }).expect(
      200,
    );
    expect(res.body.data.fields[0].required).toBe(true);
    await post('add', {
      data: { ...data(), code: 'other_form', tenantId: '2' },
    }).expect(400);
    await post('add', {
      data: { ...data(), code: 'other_form', fields: [] },
    }).expect(400);
    await post('add', { data: data() }).expect(400);
    const page = await post('page', {}).expect(200);
    expect(page.body.data.total).toBe(1);
  });

  it('修订追加版本，旧版展示和校验不受新版必填变化影响', async () => {
    const first = await add();
    const res = await post('revise', {
      data: data(true),
      baseRevision: 1,
    }).expect(200);
    expect(res.body.data.revision).toBe(2);
    expect(res.body.data.id).not.toBe(first.id);
    const old = await post('info', { id: first.id }).expect(200);
    expect(old.body.data.designer).toEqual(first.designer);
    await post('validate', { definitionId: first.id, data: {} }).expect(200);
    const invalid = await post('validate', {
      definitionId: res.body.data.id,
      data: {},
    }).expect(400);
    expect(invalid.body.data.errors).toContainEqual({
      field: 'data.reason',
      messages: ['必填字段不能为空'],
    });
    await post('validate', {
      definitionId: res.body.data.id,
      data: { reason: '年假' },
    }).expect(200);
    await post('revise', { data: data(), baseRevision: 1 }).expect(409);
    await post('update', {
      id: first.id,
      version: 1,
      data: { name: '覆盖' },
    }).expect(404);
    await post('delete', { ids: [first.id] }).expect(404);
  });

  it('两个并发修订相同基版只有一次成功，历史和新版本均完整', async () => {
    await add();
    const results = await Promise.all([
      post('revise', { data: data(true), baseRevision: 1 }),
      post('revise', { data: data(), baseRevision: 1 }),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const page = await post('page', { eq: { code: 'leave_request' } }).expect(
      200,
    );
    expect(page.body.data.total).toBe(2);
    expect(
      page.body.data.list.map((row: { revision: number }) => row.revision),
    ).toEqual([2, 1]);
  });

  it('相同幂等键重试创建不产生第二条快照', async () => {
    const key = randomUUID();
    const send = () =>
      post('add', { data: data() }).set('Idempotency-Key', key);
    const first = await send().expect(200),
      second = await send().expect(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect((await post('page', {}).expect(200)).body.data.total).toBe(1);
  });

  it.each([
    ['1', '2'],
    ['2', '1'],
  ])('%s→%s详情、校验及修订不可跨租户，同编码可独立创建', async (a, b) => {
    const first = await add(a);
    await post('info', { id: first.id }, b).expect(404);
    await post('validate', { definitionId: first.id, data: {} }, b).expect(404);
    await post('revise', { data: data(), baseRevision: 1 }, b).expect(404);
    expect((await post('page', {}, b).expect(200)).body.data.total).toBe(0);
    await add(b);
    expect((await post('page', {}, b).expect(200)).body.data.total).toBe(1);
  });

  it('无角色及只读角色不能创建、修订或验证；匿名访问401', async () => {
    await post('add', { data: data() }, '1', '2').expect(403);
    await post('add', { data: data() }, '1', '3').expect(403);
    await post('revise', { data: data(), baseRevision: 1 }, '1', '3').expect(
      403,
    );
    await post('validate', { definitionId: '1', data: {} }, '1', '3').expect(
      403,
    );
    await post('page', {}).set('x-test-anon', '1').expect(401);
  });

  it('脚本、非法联动和未知提交字段失败时不留新版本', async () => {
    const first = await add();
    await post('revise', {
      data: {
        ...data(),
        designer: {
          ...data().designer,
          rule: [{ ...data().designer.rule[0], on: { change: 'evil()' } }],
        },
      },
      baseRevision: 1,
    }).expect(400);
    await post('validate', {
      definitionId: first.id,
      data: { tenantId: '2' },
    }).expect(400);
    expect((await post('page', {}).expect(200)).body.data.total).toBe(1);
    const fields = await app
      .get(RequestContext)
      .run({ tenantId: '1' }, () =>
        app.get(FormDefinitionService).fieldsFor(first.id),
      );
    expect(fields[0].field).toBe('reason');
    await expect(
      app
        .get(RequestContext)
        .run({ tenantId: '2' }, () =>
          app.get(FormDefinitionService).fieldsFor(first.id),
        ),
    ).rejects.toMatchObject({ code: 4004 });
  });

  it('OpenAPI导出包含强类型字段清单、请求和失败响应', () => {
    const doc = buildOpenApiDocument(app, 'test');
    expect(
      doc.paths['/admin/form/definition/revise']?.post?.responses,
    ).toHaveProperty('409');
    expect(
      doc.paths['/admin/form/definition/validate']?.post?.responses,
    ).toHaveProperty('404');
    expect(doc.components?.schemas?.FormFieldDto).toMatchObject({
      properties: { field: { type: 'string' }, validation: expect.any(Object) },
    });
  });
});
