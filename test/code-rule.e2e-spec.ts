import { CommonCodeRuleStatus1794618000000 } from '../src/database/migrations/1794618000000-CommonCodeRuleStatus.js';
import { DictionaryTags1794614400000 } from '../src/database/migrations/1794614400000-DictionaryTags.js';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PermissionSource } from '../src/core/permission/permission-source.js';
import { RequestContext } from '../src/core/tenant/request-context.js';
import { CodeRuleService } from '../src/modules/code-rule/service/code-rule.service.js';
import { CODE_USAGES } from '../src/modules/code-rule/service/usage-registry.js';
import { createTestModule } from './support/test-auth.js';
import { assertTestDatabase } from './support/test-database.js';
import { clearTestRedis, rawRedis } from './support/test-redis.js';
import { CodeRules1794528000000 } from '../src/database/migrations/1794528000000-CodeRules.js';

describe('T43真实MySQL编码分配、规则与用途隔离', () => {
  let app: INestApplication,
    db: DataSource,
    service: CodeRuleService,
    ctx: RequestContext;
  const usage = (key: string) => ({
    key,
    name: key,
    resource: 'form/definition',
    field: 'code',
    maxLength: 64,
    charset: 'lower_slug',
    uniqueScope: 'tenant',
    allowRuleSwitch: true,
  });
  beforeAll(async () => {
    const m = await createTestModule({ imports: [AppModule] })
      .overrideProvider(CODE_USAGES)
      .useValue([usage('form_definition_code'), usage('other_code')])
      .overrideProvider(PermissionSource)
      .useValue({
        loadGrants: async (_t: string, u: string) =>
          u === '2'
            ? []
            : [
                {
                  roleId: 'admin',
                  scopeOrgId: null,
                  permissions: [],
                  allPermissions: true,
                  dataScope: 'all',
                },
              ],
        loadOrgs: async () => [],
        loadMenus: async () => [],
      })
      .compile();
    app = m.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(DataSource);
    assertTestDatabase(db.options.database, process.env.DB_NAME);
    const dictionaryRunner = db.createQueryRunner();
    try {
      await new DictionaryTags1794614400000().up(dictionaryRunner);
      await new CommonCodeRuleStatus1794618000000().up(dictionaryRunner);
    } finally {
      await dictionaryRunner.release();
    }
    service = app.get(CodeRuleService);
    ctx = app.get(RequestContext);
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    assertTestDatabase(db.options.database, process.env.DB_NAME);
    for (const t of [
      'form_definition',
      'sys_code_allocation',
      'sys_code_sequence',
      'sys_code_binding',
      'sys_code_rule_version',
      'sys_code_rule',
    ])
      await db.query(`DELETE FROM ${t}`);
    const r = rawRedis();
    try {
      await clearTestRedis(r);
    } finally {
      await r.quit();
    }
  });
  const post = (path: string, body: object = {}, tenant = '1', user = '1') =>
    request(app.getHttpServer())
      .post(`/admin/system/code-rule/${path}`)
      .set('x-test-user', user)
      .set('x-test-tenant', tenant)
      .send(body);
  const data = (prefix = 'f_', start = '1', width = 6) => ({
    code: `r_${randomUUID().replaceAll('-', '')}`,
    name: '编码',
    description: '',
    timezone: 'Asia/Shanghai',
    resetPeriod: 'never',
    segments: [
      { type: 'literal', value: prefix },
      { type: 'sequence', width },
    ],
    start,
    status: '1',
  });
  async function rule(prefix = 'f_', start = '1', tenant = '1', width = 6) {
    return (
      await post('add', { data: data(prefix, start, width) }, tenant).expect(
        200,
      )
    ).body.data;
  }
  async function bound(
    prefix = 'f_',
    start = '1',
    tenant = '1',
    key = 'form_definition_code',
    width = 6,
  ) {
    const r = await rule(prefix, start, tenant, width);
    await post('binding/set', { usageKey: key, ruleId: r.id }, tenant).expect(
      200,
    );
    return r;
  }
  const take = (count = 1, tenant = '1', key = 'form_definition_code') =>
    ctx.run({ tenantId: tenant }, () =>
      db.transaction((m) =>
        service.nextManyInTx(m, [{ usageKey: key, count }]),
      ),
    );
  it('序号监控按周期和最近编码搜索，规则过滤与租户边界仍生效', async () => {
    const first = await bound('search_');
    await bound('other_', '1', '1', 'other_code');
    await take();
    await take(1, '1', 'other_code');
    await bound('search_', '1', '2');
    await take(1, '2');
    const schema = await request(app.getHttpServer())
      .get('/admin/system/code-sequence/schema')
      .set('x-test-user', '1')
      .set('x-test-tenant', '1')
      .expect(200);
    expect(schema.body.data.actions.page.keyWords).toEqual([
      'periodKey',
      'lastCode',
    ]);
    const page = (keyword: string, ruleId = first.id) =>
      request(app.getHttpServer())
        .post('/admin/system/code-sequence/page')
        .set('x-test-user', '1')
        .set('x-test-tenant', '1')
        .send({ page: 1, size: 20, keyword, eq: { ruleId } });
    const found = await page('search_').expect(200);
    expect(found.body.data.total).toBe(1);
    expect(found.body.data.list[0].lastCode).toBe('search_000001');
    expect((await page('other_').expect(200)).body.data.total).toBe(0);
    expect((await page('').expect(200)).body.data.total).toBe(1);
    expect((await page('all').expect(200)).body.data.total).toBe(1);
    await page('', 'not-an-id').expect(400);
  });
  it('正式迁移可往返，计数器与登记表唯一索引和实体一致', async () => {
    const runner = db.createQueryRunner();
    try {
      const migration = new CodeRules1794528000000();
      await migration.down(runner);
      await migration.up(runner);
      const table = await runner.getTable('sys_code_sequence');
      expect(
        table?.indices.find((i) => i.name === 'uk_code_sequence')?.columnNames,
      ).toEqual(['tenant_id', 'rule_id', 'period_key']);
      await bound();
      expect((await take())[0]?.codes[0]).toBe('f_000001');
    } finally {
      await runner.release();
    }
  });
  it('真实锁等待超时映射409并回滚，释放锁后整事务重试只分配一次', async () => {
    await bound();
    await take();
    const owner = db.createQueryRunner(),
      waiter = db.createQueryRunner();
    try {
      await owner.connect();
      await waiter.connect();
      await owner.startTransaction();
      await owner.query('SELECT id FROM sys_code_sequence FOR UPDATE');
      await waiter.query('SET SESSION innodb_lock_wait_timeout = 1');
      await waiter.startTransaction();
      await expect(
        ctx.run({ tenantId: '1' }, () =>
          service.nextInTx(waiter.manager, 'form_definition_code'),
        ),
      ).rejects.toMatchObject({ code: 4009 });
      await waiter.rollbackTransaction();
      await owner.rollbackTransaction();
      expect((await take())[0]?.codes[0]).toBe('f_000002');
      expect((await db.query('SELECT * FROM sys_code_allocation')).length).toBe(
        2,
      );
    } finally {
      if (owner.isTransactionActive) await owner.rollbackTransaction();
      if (waiter.isTransactionActive) await waiter.rollbackTransaction();
      await waiter.query('SET SESSION innodb_lock_wait_timeout = 50');
      await owner.release();
      await waiter.release();
    }
  });
  it('真实交叉行锁产生死锁，失败事务不内部重试，回滚后能再次取号', async () => {
    await bound();
    await bound('g_', '1', '1', 'other_code');
    await take();
    await take(1, '1', 'other_code');
    const ids = await db.query('SELECT id FROM sys_code_sequence ORDER BY id');
    const a = db.createQueryRunner(),
      b = db.createQueryRunner();
    try {
      await a.connect();
      await b.connect();
      await a.startTransaction();
      await b.startTransaction();
      await a.query('SELECT id FROM sys_code_sequence WHERE id=? FOR UPDATE', [
        ids[0].id,
      ]);
      await b.query('SELECT id FROM sys_code_sequence WHERE id=? FOR UPDATE', [
        ids[1].id,
      ]);
      const results = await Promise.allSettled([
        ctx.run({ tenantId: '1' }, () =>
          service.nextInTx(a.manager, 'other_code'),
        ),
        ctx.run({ tenantId: '1' }, () =>
          service.nextInTx(b.manager, 'form_definition_code'),
        ),
      ]);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected');
      if (failed?.status === 'rejected')
        expect(failed.reason).toMatchObject({ code: 4009 });
    } finally {
      if (a.isTransactionActive) await a.rollbackTransaction();
      if (b.isTransactionActive) await b.rollbackTransaction();
      await a.release();
      await b.release();
    }
    expect((await take())[0]?.codes[0]).toBe('f_000002');
    expect((await db.query('SELECT * FROM sys_code_allocation')).length).toBe(
      3,
    );
  });
  it('时间戳规则可保存、绑定、预览与批量分配，同一时刻仍通过流水保证唯一', async () => {
    const created = await post('add', {
      data: {
        ...data('ts_'),
        segments: [
          { type: 'literal', value: 'ts_' },
          { type: 'timestamp', unit: 'milliseconds' },
          { type: 'sequence', width: 6 },
        ],
      },
    }).expect(200);
    await post('binding/set', {
      usageKey: 'form_definition_code',
      ruleId: created.body.data.id,
    }).expect(200);
    const preview = await post('preview', {
      ruleId: created.body.data.id,
    }).expect(200);
    expect(preview.body.data.codes[0]).toMatch(/^ts_\d{13}000001$/);
    const result = (await take(3))[0]!.codes;
    expect(result.map((code) => code.slice(-6))).toEqual([
      '000001',
      '000002',
      '000003',
    ]);
    expect(new Set(result.map((code) => code.slice(0, -6))).size).toBe(1);
  });
  it('时区目录完整且受权限保护，旧别名不会阻断无关字段修改', async () => {
    const list = await post('timezones').expect(200);
    expect(list.body.data.list.length).toBeGreaterThan(300);
    expect(
      list.body.data.list.find(
        (x: { value: string }) => x.value === 'Asia/Shanghai',
      ).labelZh,
    ).toContain('上海');
    await post('timezones', {}, '1', '2').expect(403);
    const r = await rule();
    await db.query('UPDATE sys_code_rule SET timezone=? WHERE id=?', [
      'US/Eastern',
      r.id,
    ]);
    const info = await post('info', { id: r.id }).expect(200);
    await post('update', {
      id: r.id,
      version: info.body.data.version,
      data: { name: '只改名称', timezone: 'US/Eastern' },
    }).expect(200);
    const saved = await post('info', { id: r.id }).expect(200);
    expect(saved.body.data.timezone).toBe('US/Eastern');
    const fresh = await post('add', {
      data: { ...data(), timezone: 'Etc/UTC' },
    }).expect(200);
    expect(fresh.body.data.timezone).toBe('UTC');
    await post('add', { data: { ...data(), timezone: 'invalid/zone' } }).expect(
      400,
    );
  });
  it('规则编码格式错误显示操作说明，不暴露英文正则消息', async () => {
    const normalized = await post('add', {
      data: { ...data(), code: 'TEST_CODE' },
    }).expect(200);
    expect(normalized.body.data.code).toBe('test_code');
    await post('add', { data: { ...data(), code: 'test_code' } }).expect(400);
    const res = await post('add', {
      data: { ...data(), code: '1BAD-CODE' },
    }).expect(400);
    const messages = res.body.data.errors
      .flatMap((e: { messages: string[] }) => e.messages)
      .join('；');
    expect(messages).toContain('以小写字母开头');
    expect(messages).toContain('test_code');
    expect(messages).not.toContain('regular expression');
  });
  it('未保存配置可校验预览，缺字段、非法配置及未知用途返回可读400', async () => {
    const d = data();
    const body = {
      data: {
        timezone: d.timezone,
        resetPeriod: d.resetPeriod,
        start: d.start,
        segments: d.segments,
      },
    };
    const res = await post('validate', body).expect(200);
    expect(res.body.data.codes).toHaveLength(3);
    expect((await db.query('SELECT * FROM sys_code_sequence')).length).toBe(0);
    await post('validate', {}).expect(400);
    await post('validate', { data: { ...body.data, segments: [] } }).expect(
      400,
    );
    const r = await rule();
    await post('binding/set', {
      usageKey: 'unknown_usage',
      ruleId: r.id,
    }).expect(400);
  });
  it('插入与重复分支不混淆自增主键、起始值和批量末值；预览不占号', async () => {
    const r = await bound('f_', '1000');
    const before = await post('preview', { ruleId: r.id }).expect(200);
    expect(before.body.data.codes[0]).toBe('f_001000');
    expect((await db.query('SELECT * FROM sys_code_sequence')).length).toBe(0);
    expect((await take(3))[0]?.codes).toEqual([
      'f_001000',
      'f_001001',
      'f_001002',
    ]);
    expect((await take(10))[0]?.codes.at(-1)).toBe('f_001012');
    const seq = (await db.query('SELECT id,current FROM sys_code_sequence'))[0];
    expect(String(seq.id)).not.toBe('1012');
    expect(String(seq.current)).toBe('1012');
    await bound('g_', '5000', '1', 'other_code');
    expect((await take(10, '1', 'other_code'))[0]?.codes[0]).toBe('g_005000');
  });
  it('50并发首次分配及后续200并发分配只有一行计数器，编码无重复', async () => {
    await bound();
    const first = await Promise.all(Array.from({ length: 50 }, () => take()));
    const later = await Promise.all(Array.from({ length: 200 }, () => take()));
    const values = [...first, ...later].flatMap((x) => x[0]!.codes);
    expect(new Set(values).size).toBe(250);
    expect(
      (await db.query('SELECT current FROM sys_code_sequence')).map(
        (x: { current: string }) => String(x.current),
      ),
    ).toEqual(['250']);
  }, 30000);
  it('业务失败和溢出回滚全部分配；同一事务第二次调用拒绝', async () => {
    await bound('f_', '98', '1', 'form_definition_code', 2);
    await expect(
      ctx.run({ tenantId: '1' }, () =>
        db.transaction(async (m) => {
          await service.nextManyInTx(m, [
            { usageKey: 'form_definition_code', count: 1 },
          ]);
          throw Error('业务失败');
        }),
      ),
    ).rejects.toThrow('业务失败');
    expect((await db.query('SELECT * FROM sys_code_allocation')).length).toBe(
      0,
    );
    await expect(take(3)).rejects.toMatchObject({ code: 4009 });
    expect((await db.query('SELECT * FROM sys_code_sequence')).length).toBe(0);
    await expect(
      ctx.run({ tenantId: '1' }, () =>
        db.transaction(async (m) => {
          await service.nextInTx(m, 'form_definition_code');
          await service.nextInTx(m, 'form_definition_code');
        }),
      ),
    ).rejects.toThrow('CODE_RULE_MULTIPLE_CALLS');
    expect((await take())[0]?.codes).toEqual(['f_98']);
  });
  it('批量参数、活动事务及多用途反序请求受到约束', async () => {
    await bound();
    await bound('g_', '1', '1', 'other_code');
    await expect(
      service.nextInTx(db.manager, 'form_definition_code'),
    ).rejects.toThrow('业务事务');
    for (const count of [0, 101, 1.5])
      await expect(take(count)).rejects.toMatchObject({ code: 4000 });
    await expect(
      ctx.run({ tenantId: '1' }, () =>
        db.transaction((m) =>
          service.nextManyInTx(m, [
            { usageKey: 'other_code', count: 1 },
            { usageKey: 'other_code', count: 1 },
          ]),
        ),
      ),
    ).rejects.toMatchObject({ code: 4000 });
    const result = await Promise.all(
      [
        ['form_definition_code', 'other_code'],
        ['other_code', 'form_definition_code'],
      ].map((keys) =>
        ctx.run({ tenantId: '1' }, () =>
          db.transaction((m) =>
            service.nextManyInTx(
              m,
              keys.map((usageKey) => ({ usageKey, count: 1 })),
            ),
          ),
        ),
      ),
    );
    expect(result[1]!.map((x) => x.usageKey)).toEqual([
      'other_code',
      'form_definition_code',
    ]);
  });
  it('首次绑定排除自身、并发绑定唯一、永久标记阻止旧规则复用；安全前缀换绑', async () => {
    const first = await rule();
    const attempts = await Promise.all([
      post('binding/set', {
        usageKey: 'form_definition_code',
        ruleId: first.id,
      }),
      post('binding/set', { usageKey: 'other_code', ruleId: first.id }),
    ]);
    expect(attempts.filter((x) => x.status === 200)).toHaveLength(1);
    const key =
      attempts[0]!.status === 200 ? 'form_definition_code' : 'other_code';
    await take(1, '1', key);
    const same = await rule();
    await post('binding/set', { usageKey: key, ruleId: same.id }).expect(409);
    const fresh = await rule('new_');
    await post('binding/set', { usageKey: key, ruleId: fresh.id }).expect(200);
    await post('binding/set', { usageKey: key, ruleId: first.id }).expect(409);
    expect((await take(1, '1', key))[0]?.codes[0]).toBe('new_000001');
  });
  it('冻结行为字段、保留修订快照、停用阻止发号，已有绑定不可删除', async () => {
    const r = await bound();
    await take();
    await post('update', {
      id: r.id,
      version: 2,
      data: { start: '10' },
    }).expect(409);
    const info = await post('info', { id: r.id }).expect(200);
    await post('update', {
      id: r.id,
      version: info.body.data.version,
      data: { name: '新名称' },
    }).expect(200);
    expect(
      (await post('history', { ruleId: r.id }).expect(200)).body.data.list,
    ).toHaveLength(2);
    const next = await post('info', { id: r.id }).expect(200);
    await post('update', {
      id: r.id,
      version: next.body.data.version,
      data: { status: '0' },
    }).expect(200);
    await expect(take()).rejects.toMatchObject({ code: 4009 });
    await post('delete', { ids: [r.id] }).expect(409);
  });
  it('跨租户独立计数、详情与预览隔离；无权限、伪造用途和额外字段拒绝', async () => {
    const a = await bound();
    await bound('f_', '1', '2');
    expect((await take())[0]?.codes).toEqual((await take(1, '2'))[0]?.codes);
    await post('info', { id: a.id }, '2').expect(404);
    await post('preview', { ruleId: a.id }, '2').expect(404);
    await post('page', {}, '1', '2').expect(403);
    await post('add', { data: { ...data(), tenantId: '2' } }).expect(400);
    const schema = await request(app.getHttpServer())
      .get('/admin/form/definition/schema')
      .set('x-test-user', '1')
      .set('x-test-tenant', '1')
      .expect(200);
    expect(
      schema.body.data.form.find((f: { field: string }) => f.field === 'code'),
    ).toMatchObject({ generated: true, edit: 'none' });
  });
});
