import type { INestApplication } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { APP_VERSION } from '../src/app.version.js';
import { buildOpenApiDocument } from '../src/core/swagger/swagger.js';
import {
  DemoLogController,
  DemoLogEntity,
  DemoUserController,
  DemoUserCopyController,
  DemoUserEntity,
  DemoUserService,
} from './fixtures/demo-resources.js';
import { createTestModule } from './support/test-auth.js';

/**
 * T03 验收点①：基础 CRUD 与页面描述，连真实 MySQL 测试库。
 * 别的租户的数据直接用 SQL 插入（租户上下文 T04 才接），用来验证所有读写都带了范围条件。
 */
describe('通用 CRUD（验收点①）', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  let service: DemoUserService;
  const api = (path: string) => `/admin/test/demo-user/${path}`;
  const post = (path: string, body: unknown) =>
    request(app.getHttpServer())
      .post(api(path))
      .send(body as object);
  const add = (data: Record<string, unknown>) => post('add', { data });

  beforeAll(async () => {
    const moduleRef = await createTestModule({
      imports: [
        AppModule,
        TypeOrmModule.forFeature([DemoUserEntity, DemoLogEntity]),
      ],
      controllers: [DemoUserController, DemoLogController],
      providers: [DemoUserService],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    service = app.get(DemoUserService);
    // 下面会清空数据：再确认一次连的是测试库
    const [{ db }] = await ds.query('SELECT DATABASE() db');
    expect(db).toMatch(/_test$/);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM demo_user');
    await ds.query('DELETE FROM demo_log');
    service.calls.length = 0;
  });

  /** 直接写库插一行别的租户的数据 */
  async function insertOtherTenant(username: string): Promise<string> {
    const r = await ds.query(
      "INSERT INTO demo_user (tenant_id, username, nickname, status, version) VALUES (2, ?, '别的租户', 'enabled', 1)",
      [username],
    );
    return String((r as { insertId: number }).insertId);
  }

  describe('新增', () => {
    it('成功：返回完整一行，编号是字符串、版本号为 1，不带租户和删除标记', async () => {
      const res = await add({ username: 'alice', nickname: '爱丽丝' }).expect(
        200,
      );
      expect(res.body.code).toBe(1000);
      const row = res.body.data;
      expect(row).toMatchObject({
        username: 'alice',
        nickname: '爱丽丝',
        status: 'enabled',
        version: 1,
        createdBy: '1',
      });
      expect(typeof row.id).toBe('string');
      expect(row).not.toHaveProperty('tenantId');
      expect(row).not.toHaveProperty('deletedAt');
      expect(new Date(row.createdAt).toString()).not.toBe('Invalid Date');
    });

    it('钩子改系统字段无效：租户和版本号仍由框架决定', async () => {
      const res = await add({ username: 'hooky', nickname: '钩子' }).expect(
        200,
      );
      expect(res.body.data.version).toBe(1);
      const [db] = await ds.query(
        'SELECT tenant_id, version FROM demo_user WHERE id = ?',
        [res.body.data.id],
      );
      expect(db).toMatchObject({ tenant_id: '1', version: 1 });
      expect(service.calls).toEqual(['beforeAdd', 'afterAdd']);
    });

    it.each([
      ['系统字段 version', { username: 'bob', nickname: 'b', version: 5 }],
      ['系统字段 tenantId', { username: 'bob', nickname: 'b', tenantId: '2' }],
      ['没声明的字段', { username: 'bob', nickname: 'b', foo: 1 }],
    ])('请求里带%s：400 / 4000，不入库', async (_name, data) => {
      const res = await add(data).expect(400);
      expect(res.body.code).toBe(4000);
      const [{ n }] = await ds.query('SELECT COUNT(*) n FROM demo_user');
      expect(Number(n)).toBe(0);
    });

    it('校验失败：字段错误在 data.errors，定位到具体字段', async () => {
      const res = await add({ username: 'x', nickname: '' }).expect(400);
      const fields = res.body.data.errors.map(
        (e: { field: string }) => e.field,
      );
      expect(fields).toEqual(
        expect.arrayContaining(['data.username', 'data.nickname']),
      );
    });

    it('唯一冲突：400 / 4000，字段错误指向账号，说明用字段显示名', async () => {
      await add({ username: 'dup', nickname: '一' }).expect(200);
      const res = await add({ username: 'dup', nickname: '二' }).expect(400);
      expect(res.body).toMatchObject({
        code: 4000,
        message: '账号已存在',
        data: { errors: [{ field: 'username', messages: ['账号已存在'] }] },
      });
    });

    it('别的租户有同名账号不算冲突', async () => {
      await insertOtherTenant('same');
      await add({ username: 'same', nickname: '本租户' }).expect(200);
    });

    it('beforeAdd 抛业务异常：返回它的错误，数据不入库', async () => {
      const res = await add({ username: 'blocked', nickname: 'x' }).expect(400);
      expect(res.body.data.errors[0].field).toBe('username');
      const [{ n }] = await ds.query('SELECT COUNT(*) n FROM demo_user');
      expect(Number(n)).toBe(0);
    });

    it('afterAdd 抛异常：新增和钩子里写的数据一起回滚', async () => {
      const res = await add({
        username: 'boom',
        nickname: 'boom-after',
      }).expect(500);
      expect(res.body.code).toBe(5000);
      const [{ u }] = await ds.query('SELECT COUNT(*) u FROM demo_user');
      const [{ l }] = await ds.query('SELECT COUNT(*) l FROM demo_log');
      expect([Number(u), Number(l)]).toEqual([0, 0]);
    });
  });

  describe('详情', () => {
    it('不存在和别的租户的数据：都是 404 / 4004，说明一样', async () => {
      const other = await insertOtherTenant('other');
      const a = await post('info', { id: '999999' }).expect(404);
      const b = await post('info', { id: other }).expect(404);
      expect(a.body).toEqual(b.body);
      expect(a.body).toMatchObject({
        code: 4004,
        message: '数据不存在或无权访问',
      });
    });

    it('编号格式不对：400', async () => {
      await post('info', { id: 'abc' }).expect(400);
      await post('info', { id: '0' }).expect(400);
    });
  });

  describe('分页', () => {
    beforeEach(async () => {
      await add({
        username: 'zhang',
        nickname: '张三',
        status: 'enabled',
        deptId: '10',
      });
      await add({
        username: 'li',
        nickname: '李四',
        status: 'disabled',
        deptId: '20',
      });
      await add({
        username: 'wang',
        nickname: '王五',
        status: 'enabled',
        deptId: '10',
      });
      await add({ username: 'pct_x', nickname: '百分号', status: 'enabled' });
      await insertOtherTenant('zhang-other');
    });

    it('默认按编号倒序，只返回本租户、未删除的数据', async () => {
      const res = await post('page', {}).expect(200);
      expect(res.body.data).toMatchObject({ total: 4, page: 1, size: 20 });
      expect(
        res.body.data.list.map((r: { username: string }) => r.username),
      ).toEqual(['pct_x', 'wang', 'li', 'zhang']);
    });

    it('搜索框按配置的字段模糊匹配；% 和 _ 按普通字符处理', async () => {
      const kw = await post('page', { keyword: '张' }).expect(200);
      expect(
        kw.body.data.list.map((r: { username: string }) => r.username),
      ).toEqual(['zhang']);
      const pct = await post('page', { keyword: '%' }).expect(200);
      expect(pct.body.data.total).toBe(0);
      const under = await post('page', { keyword: 'pct_' }).expect(200);
      expect(
        under.body.data.list.map((r: { username: string }) => r.username),
      ).toEqual(['pct_x']);
    });

    it('等于筛选、多列排序、翻页', async () => {
      const res = await post('page', {
        eq: { status: 'enabled', deptId: '10' },
        sort: [{ field: 'nickname', order: 'asc' }],
        page: 1,
        size: 1,
      }).expect(200);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.list).toHaveLength(1);
      const p2 = await post('page', {
        eq: { status: 'enabled', deptId: '10' },
        sort: [{ field: 'nickname', order: 'asc' }],
        page: 2,
        size: 1,
      }).expect(200);
      expect(
        [res.body.data.list[0].username, p2.body.data.list[0].username].sort(
          (a: string, b: string) => a.localeCompare(b),
        ),
      ).toEqual(['wang', 'zhang']);
    });

    it.each([
      ['不能排序的字段', { sort: [{ field: 'remark', order: 'asc' }] }],
      ['排序方向不对', { sort: [{ field: 'nickname', order: 'up' }] }],
      ['不能筛选的字段', { eq: { remark: 'x' } }],
      ['每页超过上限', { size: 101 }],
      ['页码为 0', { page: 0 }],
    ])('%s：400 / 4000', async (_name, body) => {
      const res = await post('page', body).expect(400);
      expect(res.body.code).toBe(4000);
    });
  });

  describe('修改（乐观锁）', () => {
    it('成功：版本号加 1，只改传了的字段', async () => {
      const { body } = await add({
        username: 'u1',
        nickname: '旧',
        remark: '保留',
      });
      const res = await post('update', {
        id: body.data.id,
        version: 1,
        data: { nickname: '新' },
      }).expect(200);
      expect(res.body.data).toMatchObject({
        nickname: '新',
        remark: '保留',
        version: 2,
      });
      expect(service.calls).toContain('beforeUpdate:旧->新');
    });

    it('版本号过期：409 / 4009，数据不变', async () => {
      const { body } = await add({ username: 'u2', nickname: '原' });
      await post('update', {
        id: body.data.id,
        version: 1,
        data: { nickname: '甲' },
      }).expect(200);
      const res = await post('update', {
        id: body.data.id,
        version: 1,
        data: { nickname: '乙' },
      }).expect(409);
      expect(res.body).toMatchObject({
        code: 4009,
        message: '数据已被他人修改，请刷新后重试',
      });
      const info = await post('info', { id: body.data.id });
      expect(info.body.data).toMatchObject({ nickname: '甲', version: 2 });
    });

    it('两人同时用同一个版本号保存：只有一个成功，另一个 409', async () => {
      const { body } = await add({ username: 'u3', nickname: '原' });
      const results = await Promise.all(
        ['甲', '乙', '丙', '丁', '戊'].map((n) =>
          post('update', {
            id: body.data.id,
            version: 1,
            data: { nickname: n },
          }),
        ),
      );
      const statuses = results.map((r) => r.status).sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409, 409, 409, 409]);
      const info = await post('info', { id: body.data.id });
      expect(info.body.data.version).toBe(2);
    });

    it('只在新增时可写的字段（账号）不能修改：400', async () => {
      const { body } = await add({ username: 'u4', nickname: 'x' });
      await post('update', {
        id: body.data.id,
        version: 1,
        data: { username: 'changed' },
      }).expect(400);
    });

    it('别的租户的数据：404，和不存在一样', async () => {
      const other = await insertOtherTenant('other-upd');
      const res = await post('update', {
        id: other,
        version: 1,
        data: { nickname: '改' },
      }).expect(404);
      expect(res.body.code).toBe(4004);
      const [db] = await ds.query(
        'SELECT nickname, version FROM demo_user WHERE id = ?',
        [other],
      );
      expect(db).toMatchObject({ nickname: '别的租户', version: 1 });
    });

    it('已删除的数据：404', async () => {
      const { body } = await add({ username: 'u5', nickname: 'x' });
      await post('delete', { ids: [body.data.id] }).expect(200);
      await post('update', {
        id: body.data.id,
        version: 2,
        data: { nickname: 'y' },
      }).expect(404);
    });
  });

  describe('删除（整批成败）', () => {
    it('软删除：数据还在库里，打了删除标记，查不到了，版本号加 1', async () => {
      const a = (await add({ username: 'd1', nickname: 'a' })).body.data;
      const b = (await add({ username: 'd2', nickname: 'b' })).body.data;
      const res = await post('delete', { ids: [a.id, b.id] }).expect(200);
      expect(res.body.data).toEqual({ count: 2 });
      await post('info', { id: a.id }).expect(404);
      const page = await post('page', {});
      expect(page.body.data.total).toBe(0);
      const rows = await ds.query(
        'SELECT deleted_at, version FROM demo_user ORDER BY id',
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.deleted_at).not.toBeNull();
        expect(r.version).toBe(2);
      }
      expect(service.calls).toContain('beforeDelete:2');
    });

    it('批里有一条不存在：整批 404，一条都不删', async () => {
      const a = (await add({ username: 'd3', nickname: 'a' })).body.data;
      const res = await post('delete', { ids: [a.id, '999999'] }).expect(404);
      expect(res.body.code).toBe(4004);
      await post('info', { id: a.id }).expect(200);
    });

    it('批里有一条别的租户的：整批 404，错误和不存在一样，一条都不删', async () => {
      const a = (await add({ username: 'd4', nickname: 'a' })).body.data;
      const other = await insertOtherTenant('other-del');
      const res = await post('delete', { ids: [a.id, other] }).expect(404);
      const missing = await post('delete', { ids: [a.id, '999999'] }).expect(
        404,
      );
      expect(res.body).toEqual(missing.body);
      await post('info', { id: a.id }).expect(200);
      const [db] = await ds.query(
        'SELECT deleted_at FROM demo_user WHERE id = ?',
        [other],
      );
      expect(db.deleted_at).toBeNull();
    });

    it('已经删过的再删：404', async () => {
      const a = (await add({ username: 'd5', nickname: 'a' })).body.data;
      await post('delete', { ids: [a.id] }).expect(200);
      await post('delete', { ids: [a.id] }).expect(404);
    });

    it('beforeDelete 拒绝：整批不删', async () => {
      const a = (await add({ username: 'protected', nickname: 'a' })).body.data;
      const b = (await add({ username: 'normal', nickname: 'b' })).body.data;
      await post('delete', { ids: [a.id, b.id] }).expect(400);
      await post('info', { id: b.id }).expect(200);
    });

    it.each([
      ['空数组', { ids: [] }],
      ['重复编号', { ids: ['1', '1'] }],
      ['编号格式不对', { ids: ['abc'] }],
    ])('%s：400', async (_name, body) => {
      await post('delete', body).expect(400);
    });
  });

  describe('硬删除资源、只开放部分接口', () => {
    const logApi = (p: string) => `/admin/test/demo-log/${p}`;
    it('硬删除真的删掉数据', async () => {
      const r = await request(app.getHttpServer())
        .post(logApi('add'))
        .send({ data: { message: 'hello' } })
        .expect(200);
      await request(app.getHttpServer())
        .post(logApi('delete'))
        .send({ ids: [r.body.data.id] })
        .expect(200);
      const [{ n }] = await ds.query('SELECT COUNT(*) n FROM demo_log');
      expect(Number(n)).toBe(0);
    });

    it('没开放的接口没有路由', async () => {
      await request(app.getHttpServer())
        .post(logApi('update'))
        .send({})
        .expect(404);
      await request(app.getHttpServer())
        .post(logApi('info'))
        .send({ id: '1' })
        .expect(404);
    });
  });

  describe('响应只输出可读字段', () => {
    const hidden = (row: Record<string, unknown>) => {
      expect(row).not.toHaveProperty('internalNote');
      expect(JSON.stringify(row)).not.toContain('INTERNAL_SECRET');
      expect(row).not.toHaveProperty('tenantId');
      expect(row).not.toHaveProperty('deletedAt');
    };

    it('新增、修改、详情、分页四个返回路径都不带未声明的内部列', async () => {
      const added = await add({ username: 'proj', nickname: '投影' }).expect(
        200,
      );
      hidden(added.body.data);
      const [db] = await ds.query(
        'SELECT internal_note FROM demo_user WHERE id = ?',
        [added.body.data.id],
      );
      expect(db.internal_note).toBe('INTERNAL_SECRET');
      const updated = await post('update', {
        id: added.body.data.id,
        version: 1,
        data: { nickname: '改' },
      }).expect(200);
      hidden(updated.body.data);
      const info = await post('info', { id: added.body.data.id }).expect(200);
      hidden(info.body.data);
      const page = await post('page', {}).expect(200);
      expect(page.body.data.list).toHaveLength(1);
      hidden(page.body.data.list[0]);
      expect(
        Object.keys(info.body.data).sort((a, b) => a.localeCompare(b)),
      ).toEqual([
        'createdAt',
        'createdBy',
        'deptId',
        'id',
        'nickname',
        'orgId',
        'remark',
        'status',
        'updatedAt',
        'updatedBy',
        'username',
        'version',
      ]);
    });

    it('请求里带内部字段：400，不能借此写入', async () => {
      await add({
        username: 'proj2',
        nickname: 'x',
        internalNote: 'hack',
      }).expect(400);
    });
  });

  describe('不传和清空（显式 null）', () => {
    it('非空字段传 null：400 / 4000 字段错误，数据和版本号都不变', async () => {
      const { body } = await add({
        username: 'n1',
        nickname: '原名',
        remark: '备注',
      });
      const res = await post('update', {
        id: body.data.id,
        version: 1,
        data: { nickname: null, status: null },
      }).expect(400);
      expect(res.body.code).toBe(4000);
      const fields = res.body.data.errors
        .map((e: { field: string }) => e.field)
        .sort((a: string, b: string) => a.localeCompare(b));
      expect(fields).toEqual(['data.nickname', 'data.status']);
      expect(res.body.data.errors[0].messages[0]).toMatch(/不能为空/);
      const [db] = await ds.query(
        'SELECT nickname, status, version FROM demo_user WHERE id = ?',
        [body.data.id],
      );
      expect(db).toMatchObject({
        nickname: '原名',
        status: 'enabled',
        version: 1,
      });
      expect(service.calls.some((c) => c.startsWith('beforeUpdate'))).toBe(
        false,
      );
    });

    it('可空字段传 null 表示清空；不传的字段保持原值', async () => {
      const { body } = await add({
        username: 'n2',
        nickname: '名',
        remark: '备注',
        deptId: '10',
      });
      const res = await post('update', {
        id: body.data.id,
        version: 1,
        data: { remark: null },
      }).expect(200);
      expect(res.body.data).toMatchObject({
        remark: null,
        deptId: '10',
        nickname: '名',
        version: 2,
      });
    });

    it('新增时非空字段传 null：400，不入库', async () => {
      const res = await add({
        username: 'n3',
        nickname: 'x',
        status: null,
      }).expect(400);
      expect(res.body.data.errors[0].field).toBe('data.status');
      const [{ n }] = await ds.query('SELECT COUNT(*) n FROM demo_user');
      expect(Number(n)).toBe(0);
    });
  });

  describe('页面描述', () => {
    it('GET schema 返回列、表单、筛选、字典和按动作区分的字段能力', async () => {
      const res = await request(app.getHttpServer())
        .get(api('schema'))
        .expect(200);
      const s = res.body.data;
      expect(s).toMatchObject({
        resource: 'test/demo-user',
        label: '演示用户',
        permPrefix: 'test:demo-user',
        deleteMode: 'soft',
        maxSize: 100,
        defaultSort: [{ field: 'id', order: 'desc' }],
        dictionaries: {
          status: [
            { value: 'enabled', label: '正常' },
            { value: 'disabled', label: '停用' },
          ],
        },
      });
      // 业务字段在前，系统字段在后；系统字段默认只显示创建时间，其余 hidden
      expect(s.columns.map((c: { field: string }) => c.field)).toEqual([
        'username',
        'nickname',
        'status',
        'createdBy',
        'createdAt',
        'updatedBy',
        'updatedAt',
        'orgId',
        'id',
        'version',
      ]);
      expect(
        s.columns
          .filter((c: { hidden?: boolean }) => !c.hidden)
          .map((c: { field: string }) => c.field),
      ).toEqual(['username', 'nickname', 'status', 'createdAt']);
      expect(
        Object.fromEntries(
          s.columns.map((c: { field: string; type: string }) => [
            c.field,
            c.type,
          ]),
        ),
      ).toMatchObject({
        username: 'text',
        createdAt: 'datetime',
        createdBy: 'reference',
        orgId: 'reference',
        version: 'number',
      });
      expect(
        s.columns.find((c: { field: string }) => c.field === 'username'),
      ).toMatchObject({ label: '账号', width: 140, sortable: true });
      expect(s.form.map((f: { field: string }) => f.field)).toEqual([
        'username',
        'nickname',
        'status',
        'remark',
      ]);
      expect(
        s.form.find((f: { field: string }) => f.field === 'username'),
      ).toMatchObject({ edit: 'add', required: true });
      expect(
        s.form.find((f: { field: string }) => f.field === 'status'),
      ).toMatchObject({ component: 'select', dict: 'status' });
      expect(s.actions.update.writable).toEqual([
        'nickname',
        'status',
        'deptId',
        'remark',
      ]);
      expect(s.actions.add.writable).toEqual([
        'username',
        'nickname',
        'status',
        'deptId',
        'remark',
      ]);
      expect(s.actions.page.sortable).toEqual([
        'id',
        'createdAt',
        'updatedAt',
        'username',
        'nickname',
      ]);
      expect(s.query.map((q: { field: string }) => q.field)).toEqual([
        'status',
        'deptId',
      ]);
    });
  });

  describe('接口文档', () => {
    it('文档里所有本地 $ref 都能找到定义（生成前端代码时不会遇到悬空类型）', () => {
      const doc = buildOpenApiDocument(app, APP_VERSION);
      const schemas = doc.components?.schemas ?? {};
      const refs = new Set<string>();
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object')
          for (const [k, x] of Object.entries(v)) {
            if (k === '$ref' && typeof x === 'string') refs.add(x);
            else walk(x);
          }
      };
      walk(doc);
      expect(refs.size).toBeGreaterThan(10);
      const missing = [...refs].filter(
        (r) =>
          !r.startsWith('#/components/schemas/') ||
          !(r.slice('#/components/schemas/'.length) in schemas),
      );
      expect(missing).toEqual([]);
      expect(refs).toContain('#/components/schemas/CrudSchemaDictItem');
    });

    it('每个开放的接口都有 operationId、请求体、成功和失败响应（真实 HTTP 状态）', () => {
      const doc = buildOpenApiDocument(app, APP_VERSION);
      const ops = Object.values(doc.paths).flatMap((p) =>
        Object.values(p as object),
      ) as {
        operationId: string;
        responses: Record<string, unknown>;
      }[];
      const ids = ops.map((o) => o.operationId);
      expect(ids).toEqual(
        expect.arrayContaining([
          'testDemoUserPage',
          'testDemoUserInfo',
          'testDemoUserAdd',
          'testDemoUserUpdate',
          'testDemoUserDelete',
          'testDemoUserSchema',
          'testDemoLogPage',
          'testDemoLogAdd',
          'testDemoLogDelete',
          'testDemoLogSchema',
        ]),
      );
      expect(ids).not.toContain('testDemoLogUpdate');
      const update = ops.find((o) => o.operationId === 'testDemoUserUpdate')!;
      expect(Object.keys(update.responses).sort()).toEqual([
        '200',
        '400',
        '404',
        '409',
      ]);
      const schemas = doc.components?.schemas ?? {};
      expect(schemas).toHaveProperty('TestDemoUserUpdateBody');
      expect(schemas).toHaveProperty('TestDemoUserRow');
      expect(schemas).toHaveProperty('ApiFieldError');
      const row = schemas.TestDemoUserRow as {
        properties: Record<string, unknown>;
      };
      expect(row.properties).toHaveProperty('username');
      expect(row.properties).not.toHaveProperty('tenantId');
      expect(row.properties).not.toHaveProperty('deletedAt');
      const addData = schemas.TestDemoUserAddData as {
        properties: Record<string, unknown>;
      };
      expect(Object.keys(addData.properties).sort()).toEqual([
        'deptId',
        'nickname',
        'remark',
        'status',
        'username',
      ]);
    });
  });
});

describe('一个 Service 只能服务一个资源', () => {
  it('同一实体的两个资源共用一个 Service：启动失败，不会静默互相覆盖规则', async () => {
    const moduleRef = await createTestModule({
      imports: [AppModule, TypeOrmModule.forFeature([DemoUserEntity])],
      controllers: [DemoUserController, DemoUserCopyController],
      providers: [DemoUserService],
    }).compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await expect(app.init()).rejects.toThrow(
      /已绑定到资源 test\/demo-user(-copy)?，不能再绑定/,
    );
    await app.close().catch(() => undefined);
  });
});
