import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { CrudAudit, type HardDeleteEvent } from '../src/core/crud/index.js';
import {
  DemoOrderController,
  DemoOrderEntity,
  DemoOrderItemEntity,
  DemoOrderNoteEntity,
  DemoOrderTagEntity,
} from './fixtures/demo-order.js';
import {
  DemoLogController,
  DemoLogEntity,
  DemoUserController,
  DemoUserEntity,
  DemoUserService,
} from './fixtures/demo-resources.js';

/**
 * T03 验收点③：删除方式、软删除唯一约束（activeGuard）、回收站、删除批次，连真实 MySQL 测试库。
 * 覆盖架构「删除方式 · 必须有的测试」和「主子表 · 必须有的测试」里和恢复相关的几项。
 */
describe('删除方式与回收站（验收点③）', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  const audits: HardDeleteEvent[] = [];
  const recorder: CrudAudit = {
    hardDeleted: async (e: HardDeleteEvent) => {
      audits.push(e);
    },
  };
  const http = () => request(app.getHttpServer());
  const user = (path: string, body: unknown) =>
    http()
      .post(`/admin/test/demo-user/${path}`)
      .send(body as object);
  const order = (path: string, body: unknown) =>
    http()
      .post(`/admin/test/demo-order/${path}`)
      .send(body as object);
  const addUser = async (username: string, extra: object = {}) =>
    (
      await user('add', {
        data: { username, nickname: username, ...extra },
      }).expect(200)
    ).body.data as {
      id: string;
      version: number;
    };
  const item = (clientId: string, productCode: string) => ({
    clientId,
    productCode,
    qty: 1,
  });
  const addOrder = async (orderNo: string, codes = ['P1', 'P2']) =>
    (
      await order('add', {
        data: { orderNo, title: orderNo },
        children: { items: { added: codes.map((c, n) => item(String(n), c)) } },
      }).expect(200)
    ).body.data as {
      id: string;
      version: number;
      children: { items: { id: string; productCode: string }[] };
    };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule,
        TypeOrmModule.forFeature([
          DemoUserEntity,
          DemoLogEntity,
          DemoOrderEntity,
          DemoOrderItemEntity,
          DemoOrderNoteEntity,
          DemoOrderTagEntity,
        ]),
      ],
      controllers: [DemoUserController, DemoLogController, DemoOrderController],
      providers: [DemoUserService],
    })
      .overrideProvider(CrudAudit)
      .useValue(recorder)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    const [{ db }] = await ds.query('SELECT DATABASE() db');
    expect(db).toMatch(/_test$/);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    for (const t of [
      'demo_order_tag',
      'demo_order_note',
      'demo_order_item',
      'demo_order',
      'demo_user',
      'demo_log',
    ])
      await ds.query(`DELETE FROM ${t}`);
    audits.length = 0;
  });

  describe('软删除下的唯一约束（activeGuard）', () => {
    it('并发新建同名：只有一个成功，其余 400 账号已存在', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          user('add', { data: { username: 'same', nickname: 'x' } }),
        ),
      );
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 400, 400, 400, 400, 400,
      ]);
      for (const r of results.filter((x) => x.status === 400))
        expect(r.body.message).toBe('账号已存在');
    });

    it('删除后可以重用账号；反复删除重建多次也可以', async () => {
      for (let n = 0; n < 3; n++) {
        const u = await addUser('reuse');
        await user('delete', { ids: [u.id] }).expect(200);
      }
      await addUser('reuse');
      const rows = await ds.query(
        "SELECT deleted_at, active_guard FROM demo_user WHERE username = 'reuse'",
      );
      expect(rows).toHaveLength(4);
      expect(
        rows.filter((r: { deleted_at: unknown }) => r.deleted_at === null),
      ).toHaveLength(1);
      expect(
        rows.filter((r: { active_guard: unknown }) => r.active_guard === 1),
      ).toHaveLength(1);
    });

    it('有效记录仍然唯一：同名的第二条有效记录 400', async () => {
      await addUser('dup');
      await user('add', { data: { username: 'dup', nickname: 'y' } }).expect(
        400,
      );
    });
  });

  describe('回收站', () => {
    it('列表只列本租户已删除的数据，带删除时间，按删除时间倒序，搜索可用', async () => {
      const a = await addUser('rec-a');
      const b = await addUser('rec-b');
      await addUser('rec-alive');
      await user('delete', { ids: [a.id] }).expect(200);
      await user('delete', { ids: [b.id] }).expect(200);
      await ds.query(
        "INSERT INTO demo_user (tenant_id, username, nickname, status, version, deleted_at) VALUES (2, 'rec-other', 'x', 'enabled', 1, NOW(3))",
      );
      const res = await user('recycle/page', {}).expect(200);
      expect(res.body.data.total).toBe(2);
      const list = res.body.data.list as {
        id: string;
        username: string;
        deletedAt: string;
      }[];
      expect(list.map((r) => r.username)).toEqual(['rec-b', 'rec-a']);
      expect(new Date(list[0].deletedAt).toString()).not.toBe('Invalid Date');
      expect(list[0]).not.toHaveProperty('internalNote');
      expect(list[0]).not.toHaveProperty('deleteBatch');
      const kw = await user('recycle/page', { keyword: 'rec-a' }).expect(200);
      expect(
        kw.body.data.list.map((r: { username: string }) => r.username),
      ).toEqual(['rec-a']);
    });

    it('恢复：重新可见，版本号加 1，删除标记和批次清空', async () => {
      const a = await addUser('restore-me');
      await user('delete', { ids: [a.id] }).expect(200);
      await user('restore', { ids: [a.id] }).expect(200);
      const info = await user('info', { id: a.id }).expect(200);
      expect(info.body.data.version).toBe(3);
      const [db] = await ds.query(
        'SELECT deleted_at, delete_batch, active_guard FROM demo_user WHERE id = ?',
        [a.id],
      );
      expect(db).toMatchObject({
        deleted_at: null,
        delete_batch: null,
        active_guard: 1,
      });
    });

    it('恢复时账号已被新记录占用：400 提示冲突，不覆盖也不改名，仍在回收站', async () => {
      const old = await addUser('taken');
      await user('delete', { ids: [old.id] }).expect(200);
      await addUser('taken');
      const res = await user('restore', { ids: [old.id] }).expect(400);
      expect(res.body).toMatchObject({ code: 4000, message: '账号已存在' });
      const [db] = await ds.query(
        'SELECT deleted_at, username FROM demo_user WHERE id = ?',
        [old.id],
      );
      expect(db.deleted_at).not.toBeNull();
      expect(db.username).toBe('taken');
    });

    it('批量恢复整批成败：一条冲突，其他也不恢复', async () => {
      const a = await addUser('batch-a');
      const b = await addUser('batch-b');
      await user('delete', { ids: [a.id, b.id] }).expect(200);
      await addUser('batch-b');
      await user('restore', { ids: [a.id, b.id] }).expect(400);
      await user('info', { id: a.id }).expect(404);
    });

    it('没删除的、不存在的、别的租户的：恢复和彻底删除都 404，响应一样，整批不执行', async () => {
      const alive = await addUser('alive');
      const gone = await addUser('gone');
      await user('delete', { ids: [gone.id] }).expect(200);
      const r = await ds.query(
        "INSERT INTO demo_user (tenant_id, username, nickname, status, version, deleted_at) VALUES (2, 'other-del', 'x', 'enabled', 1, NOW(3))",
      );
      const other = String((r as { insertId: number }).insertId);
      for (const action of ['restore', 'purge']) {
        const bodies = [];
        for (const bad of [alive.id, '999999', other]) {
          const res = await user(action, { ids: [gone.id, bad] }).expect(404);
          bodies.push(res.body);
        }
        expect(bodies[1]).toEqual(bodies[0]);
        expect(bodies[2]).toEqual(bodies[0]);
      }
      const [g] = await ds.query(
        'SELECT deleted_at FROM demo_user WHERE id = ?',
        [gone.id],
      );
      expect(g.deleted_at).not.toBeNull();
      expect(audits).toHaveLength(0);
    });

    it('彻底删除：真的删掉，删除前把整行内容留底（含内部列）', async () => {
      const a = await addUser('purge-me', { remark: '留底' });
      await user('delete', { ids: [a.id] }).expect(200);
      await user('purge', { ids: [a.id] }).expect(200);
      const rows = await ds.query('SELECT id FROM demo_user WHERE id = ?', [
        a.id,
      ]);
      expect(rows).toHaveLength(0);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        resource: 'test/demo-user',
        reason: 'purge',
      });
      expect(audits[0].rows[0]).toMatchObject({
        id: a.id,
        username: 'purge-me',
        remark: '留底',
        internalNote: 'INTERNAL_SECRET',
      });
    });

    it('没删除的数据不能直接彻底删除', async () => {
      const a = await addUser('not-deleted');
      await user('purge', { ids: [a.id] }).expect(404);
      await user('info', { id: a.id }).expect(200);
    });
  });

  describe('主子表的删除批次', () => {
    it('先删一条明细，再删主表，再恢复主表：那条明细仍在回收站，其他明细跟着恢复', async () => {
      const o = await addOrder('B-1', ['P1', 'P2', 'P3']);
      const [p1, p2, p3] = o.children.items;
      await order('update', {
        id: o.id,
        version: 1,
        data: {},
        children: { items: { deleted: [p1.id] } },
      }).expect(200);
      await order('delete', { ids: [o.id] }).expect(200);
      const batches = await ds.query(
        'SELECT id, delete_batch FROM demo_order_item WHERE order_id = ? ORDER BY id',
        [o.id],
      );
      expect(
        new Set(batches.map((b: { delete_batch: string }) => b.delete_batch))
          .size,
      ).toBe(2);
      await order('restore', { ids: [o.id] }).expect(200);
      const info = await order('info', { id: o.id }).expect(200);
      expect(
        info.body.data.children.items.map((r: { id: string }) => r.id),
      ).toEqual([p2.id, p3.id]);
      const [d] = await ds.query(
        'SELECT deleted_at FROM demo_order_item WHERE id = ?',
        [p1.id],
      );
      expect(d.deleted_at).not.toBeNull();
    });

    it('主子表恢复冲突：整批回滚，主表和明细都还在回收站', async () => {
      const a = await addOrder('C-1');
      const b = await addOrder('C-2');
      await order('delete', { ids: [a.id, b.id] }).expect(200);
      await addOrder('C-2');
      const res = await order('restore', { ids: [a.id, b.id] }).expect(400);
      expect(res.body.message).toBe('单号已存在');
      const masters = await ds.query(
        'SELECT deleted_at FROM demo_order WHERE id IN (?, ?)',
        [a.id, b.id],
      );
      for (const m of masters) expect(m.deleted_at).not.toBeNull();
      const items = await ds.query(
        'SELECT deleted_at FROM demo_order_item WHERE order_id IN (?, ?)',
        [a.id, b.id],
      );
      expect(items).toHaveLength(4);
      for (const i of items) expect(i.deleted_at).not.toBeNull();
    });

    it('彻底删除主表：主表和它名下全部明细（包括之前单独删的）一起真删，留底里有明细', async () => {
      const o = await addOrder('D-1', ['P1', 'P2']);
      await order('update', {
        id: o.id,
        version: 1,
        data: {},
        children: { items: { deleted: [o.children.items[0].id] } },
      }).expect(200);
      await order('delete', { ids: [o.id] }).expect(200);
      await order('purge', { ids: [o.id] }).expect(200);
      const left = await ds.query(
        'SELECT COUNT(*) n FROM demo_order_item WHERE order_id = ?',
        [o.id],
      );
      expect(Number(left[0].n)).toBe(0);
      expect(audits).toHaveLength(1);
      expect((audits[0].children.items as object[]).length).toBe(2);
    });
  });

  describe('硬删除资源', () => {
    it('删除前留底，然后真删；没有回收站接口', async () => {
      const r = await http()
        .post('/admin/test/demo-log/add')
        .send({ data: { message: 'hello' } })
        .expect(200);
      await http()
        .post('/admin/test/demo-log/delete')
        .send({ ids: [r.body.data.id] })
        .expect(200);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        resource: 'test/demo-log',
        reason: 'delete',
      });
      expect(audits[0].rows[0]).toMatchObject({ message: 'hello' });
      await http()
        .post('/admin/test/demo-log/restore')
        .send({ ids: ['1'] })
        .expect(404);
      await http()
        .post('/admin/test/demo-log/recycle/page')
        .send({})
        .expect(404);
    });
  });
});
