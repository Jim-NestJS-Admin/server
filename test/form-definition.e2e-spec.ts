import { CommonCodeRuleStatus1794618000000 } from '../src/database/migrations/1794618000000-CommonCodeRuleStatus.js';
import { DictionaryTags1794614400000 } from '../src/database/migrations/1794614400000-DictionaryTags.js';
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
import { FormVersionArchive1814906215523 } from '../src/database/migrations/1814906215523-FormVersionArchive.js';
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
    const dictionaryRunner = ds.createQueryRunner();
    try {
      await new DictionaryTags1794614400000().up(dictionaryRunner);
      await new CommonCodeRuleStatus1794618000000().up(dictionaryRunner);
    } finally {
      await dictionaryRunner.release();
    }
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    assertTestDatabase(ds.options.database, process.env.DB_NAME);
    await ds.query('DELETE FROM form_definition');
    for (const table of [
      'sys_code_allocation',
      'sys_code_sequence',
      'sys_code_binding',
      'sys_code_rule_version',
      'sys_code_rule',
    ])
      await ds.query(`DELETE FROM ${table}`);
    const redis = rawRedis();
    try {
      await clearTestRedis(redis);
    } finally {
      await redis.quit();
    }
    for (const tenant of ['1', '2']) {
      const created = await request(app.getHttpServer())
        .post('/admin/system/code-rule/add')
        .set('x-test-user', '1')
        .set('x-test-tenant', tenant)
        .send({
          data: {
            code: 'forms',
            name: '表单编码',
            description: '',
            timezone: 'Asia/Shanghai',
            resetPeriod: 'never',
            segments: [
              { type: 'literal', value: 'form_' },
              { type: 'sequence', width: 6 },
            ],
            start: '1',
            status: '1',
          },
        })
        .expect(200);
      await request(app.getHttpServer())
        .post('/admin/system/code-rule/binding/set')
        .set('x-test-user', '1')
        .set('x-test-tenant', tenant)
        .send({
          usageKey: 'form_definition_code',
          ruleId: created.body.data.id,
        })
        .expect(200);
    }
  });
  let firstId = '',
    firstCode = '';
  const post = (path: string, body: object, tenant = '1', user = '1') =>
    request(app.getHttpServer())
      .post('/admin/form/definition/' + path)
      .set('x-test-user', user)
      .set('x-test-tenant', tenant)
      .send(path === 'revise' ? { definitionId: firstId, ...body } : body);
  const data = (required = false) => ({
    name: '请假申请',
    designer: {
      schemaVersion: 1,
      rule: [
        { type: 'input', field: 'reason', title: '原因', $required: required },
      ],
    },
  });
  const add = async (tenant = '1', required = false) => {
    const row = (
      await post('add', { data: data(required) }, tenant).expect(200)
    ).body.data;
    firstId = row.id;
    firstCode = row.code;
    return row as {
      id: string;
      revision: number;
      code: string;
      designer: object;
      fields: object[];
    };
  };

  it('正式迁移up/down/up可执行，字段与唯一索引可供实体使用', async () => {
    const runner = ds.createQueryRunner();
    const migration = new FormDefinition1794470400000();
    try {
      await migration.down(runner);
      await migration.up(runner);
      await new FormVersionArchive1814906215523().up(runner);
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

  it('主列表先按编码选最新版本再搜索和分页，保留同租户历史列表', async () => {
    const first = await add();
    const latest = (
      await post('revise', {
        data: { ...data(), name: '新版名称' },
        baseRevision: 1,
      }).expect(200)
    ).body.data;
    const another = await add();
    const otherTenant = await add('2');
    expect(otherTenant.code).toBe(first.code);
    for (const baseRevision of [1, 2]) {
      await post(
        'revise',
        { data: { ...data(), name: '其他租户' }, baseRevision },
        '2',
      ).expect(200);
    }
    const page = (body: object, tenant = '1') =>
      post('current-page', body, tenant).expect(200);
    const firstPage = (await page({ page: 1, size: 1 })).body.data;
    const secondPage = (await page({ page: 2, size: 1 })).body.data;
    expect(firstPage).toMatchObject({ total: 2, list: [{ id: latest.id }] });
    expect(secondPage).toMatchObject({ total: 2, list: [{ id: another.id }] });
    expect((await page({ keyword: '请假申请' })).body.data).toMatchObject({
      total: 1,
      list: [{ id: another.id }],
    });
    expect(
      (await page({ eq: { code: first.code } }, '2')).body.data,
    ).toMatchObject({
      total: 1,
      list: [{ revision: 3 }],
    });
    expect(
      (await post('page', { eq: { code: first.code } }).expect(200)).body.data
        .total,
    ).toBe(2);
    await post('current-page', { size: 0 }).expect(400);
    await post('current-page', {}, '1', '3').expect(403);
  });

  it('未使用的旧版本可以归档和恢复，归档第一版后仍能从第二版创建第三版', async () => {
    const first = await add();
    const identity = { id: first.id, version: 1 };
    await post('set-archived', { ...identity, archived: true }).expect(400);
    const second = (
      await post('revise', { data: data(), baseRevision: 1 }).expect(200)
    ).body.data;
    await post(
      'set-archived',
      { ...identity, archived: true },
      '1',
      '3',
    ).expect(403);
    await post('set-archived', { ...identity, archived: true }, '2').expect(
      404,
    );
    await post('set-archived', { ...identity, archived: true }).expect(200);
    const active = (await post('page', {}).expect(200)).body.data.list;
    expect(active.map((row: { id: string }) => row.id)).toEqual([second.id]);
    const archived = (
      await post('page', { eq: { archived: true } }).expect(200)
    ).body.data.list;
    expect(archived).toMatchObject([
      { id: first.id, version: 2, archived: true },
    ]);
    await post('validate', { definitionId: first.id, data: {} }).expect(404);
    const third = await post('revise', {
      definitionId: second.id,
      data: data(),
      baseRevision: 2,
    }).expect(200);
    expect(third.body.data).toMatchObject({
      code: first.code,
      revision: 3,
      archived: false,
    });
    await post('set-archived', { ...identity, archived: false }).expect(409);
    await post('set-archived', {
      id: first.id,
      version: 2,
      archived: false,
    }).expect(200);
    expect((await post('page', {}).expect(200)).body.data.total).toBe(3);
  });

  it('已有提交记录的旧版本不能归档', async () => {
    const first = await add();
    await post('revise', { data: data(), baseRevision: 1 }).expect(200);
    await request(app.getHttpServer())
      .post('/admin/form/submission/add')
      .set('x-test-user', '1')
      .set('x-test-tenant', '1')
      .send({ data: { definitionId: first.id, values: { reason: '测试' } } })
      .expect(200);
    await post('set-archived', {
      id: first.id,
      version: 1,
      archived: true,
    }).expect(400);
  });

  it('提交详情使用固定版本的字段顺序和选项标签，保留原值', async () => {
    const options = [
      { label: '事假', value: '1' },
      { label: '病假', value: '2' },
    ];
    const design = {
      ...data(),
      designer: {
        schemaVersion: 1,
        rule: [
          { type: 'select', field: 'kind', title: '请假类型', options },
          { type: 'checkbox', field: 'details', title: '明细', options },
          { type: 'radio', field: 'related', title: '关联选项', options },
        ],
        linkages: [
          {
            source: 'kind',
            target: 'related',
            operator: 'eq',
            value: '1',
            action: 'options',
            whenTrue: [{ label: '联动病假', value: '2' }],
            whenFalse: options,
          },
        ],
      },
    };
    const first = (await post('add', { data: design }).expect(200)).body.data;
    const submission = (path: string, body: object, tenant = '1') =>
      request(app.getHttpServer())
        .post(`/admin/form/submission/${path}`)
        .set('x-test-user', '1')
        .set('x-test-tenant', tenant)
        .send(body);
    const values = { related: '2', details: ['2', '1'], kind: '1' };
    const record = (
      await submission('add', {
        data: { definitionId: first.id, values },
      }).expect(200)
    ).body.data;
    await post('revise', {
      definitionId: first.id,
      data: {
        ...design,
        designer: {
          ...design.designer,
          rule: [...design.designer.rule].reverse().map((rule) => ({
            ...rule,
            options: options.map((option) => ({
              ...option,
              label: `新版${option.label}`,
            })),
          })),
          linkages: [],
        },
      },
      baseRevision: 1,
    }).expect(200);
    const detail = (await submission('info', { id: record.id }).expect(200))
      .body.data;
    expect(Object.keys(detail.values)).toEqual(['kind', 'details', 'related']);
    expect(detail).toMatchObject({
      revision: 1,
      values,
      _display: {
        'values.kind': '事假',
        'values.details': '病假、事假',
        'values.related': '联动病假',
      },
    });
    await submission('info', { id: record.id }, '2').expect(404);
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
    await post('add', { data: { ...data(), code: 'forbidden' } }).expect(400);
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
    const page = await post('page', { eq: { code: firstCode } }).expect(200);
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
    expect(doc.components?.schemas?.FormDesignerDto).toMatchObject({
      properties: {
        rule: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
        option: { type: 'object', additionalProperties: true },
      },
    });
    expect(doc.components?.schemas?.ValidateFormBody).toMatchObject({
      properties: { data: { type: 'object', additionalProperties: true } },
    });
  });
});
