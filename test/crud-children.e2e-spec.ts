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
  DemoOrderController,
  DemoOrderEntity,
  DemoOrderItemEntity,
  DemoOrderItemReadController,
  DemoOrderItemReadService,
  DemoOrderItemWriteController,
  DemoOrderNoteEntity,
  DemoOrderTagEntity,
} from './fixtures/demo-order.js';
import { createTestModule } from './support/test-auth.js';

const ENTITIES = [
  DemoOrderEntity,
  DemoOrderItemEntity,
  DemoOrderNoteEntity,
  DemoOrderTagEntity,
];

type Err = {
  resource?: string;
  id?: string;
  clientId?: string;
  index?: number;
  field: string;
  messages: string[];
};

/**
 * T03 验收点②：主子表聚合保存，连真实 MySQL 测试库。
 * 覆盖架构「主子表 · 必须有的测试」和 T03 补充验收里的 clientId、错误定位要求。
 */
describe('主子表聚合保存（验收点②）', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  const post = (path: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`/admin/test/demo-order/${path}`)
      .send(body as object);
  const item = (
    clientId: string,
    productCode: string,
    qty = 1,
    extra: object = {},
  ) => ({
    clientId,
    productCode,
    qty,
    ...extra,
  });
  const create = async (
    items = [item('a', 'P1', 1, { sort: 2 }), item('b', 'P2', 2, { sort: 1 })],
  ) => {
    const res = await post('add', {
      data: {
        orderNo: `NO-${Math.random().toString(36).slice(2, 10)}`,
        title: '订单',
      },
      children: { items: { added: items } },
    }).expect(200);
    return res.body.data as {
      id: string;
      version: number;
      children: {
        items: {
          id: string;
          productCode: string;
          qty: number;
          remark: string | null;
        }[];
        notes: unknown[];
      };
    };
  };
  const errorsOf = (res: { body: { data: { errors: Err[] } } }) =>
    res.body.data.errors;
  const counts = async () => {
    const [{ o }] = await ds.query('SELECT COUNT(*) o FROM demo_order');
    const [{ i }] = await ds.query('SELECT COUNT(*) i FROM demo_order_item');
    return [Number(o), Number(i)];
  };

  beforeAll(async () => {
    const moduleRef = await createTestModule({
      imports: [AppModule, TypeOrmModule.forFeature(ENTITIES)],
      controllers: [DemoOrderController],
    }).compile();
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
    ])
      await ds.query(`DELETE FROM ${t}`);
  });

  describe('新增', () => {
    it('主表和明细一起写入；详情按排序字段返回明细，不带 clientId 和外键', async () => {
      const order = await create();
      expect(order.version).toBe(1);
      expect(order.children.items.map((r) => r.productCode)).toEqual([
        'P2',
        'P1',
      ]);
      expect(order.children.notes).toEqual([]);
      const row = order.children.items[0] as Record<string, unknown>;
      expect(row).not.toHaveProperty('clientId');
      expect(row).not.toHaveProperty('orderId');
      expect(row).not.toHaveProperty('tenantId');
      expect(typeof row.id).toBe('string');
      const info = await post('info', { id: order.id }).expect(200);
      expect(info.body.data.children).toEqual(order.children);
    });

    it('明细少于最少行数：400，主表也不写入', async () => {
      const res = await post('add', {
        data: { orderNo: 'X1', title: 't' },
      }).expect(400);
      expect(errorsOf(res)).toEqual([
        {
          resource: 'items',
          field: '_rows',
          messages: ['订单明细至少要有 1 行'],
        },
      ]);
      expect(await counts()).toEqual([0, 0]);
    });

    it('某一行字段不对：按 resource + clientId 定位到行和字段，整批不写', async () => {
      const res = await post('add', {
        data: { orderNo: 'X2', title: 't' },
        children: {
          items: { added: [item('ok', 'P1'), item('bad', 'P2', 0)] },
        },
      }).expect(400);
      expect(res.body.code).toBe(4000);
      expect(errorsOf(res)).toEqual([
        expect.objectContaining({
          resource: 'items',
          clientId: 'bad',
          field: 'qty',
        }),
      ]);
      expect(await counts()).toEqual([0, 0]);
    });

    it.each([
      [
        '缺 clientId',
        [{ productCode: 'P1', qty: 1 }],
        { index: 0, field: 'clientId' },
      ],
      ['clientId 是空串', [item('', 'P1')], { index: 0, field: 'clientId' }],
      [
        'clientId 不是字符串',
        [{ clientId: 1, productCode: 'P1', qty: 1 }],
        { index: 0, field: 'clientId' },
      ],
      [
        'clientId 重复',
        [item('x', 'P1'), item('x', 'P2')],
        { index: 1, clientId: 'x', field: 'clientId' },
      ],
    ])('%s：整个保存被拒', async (_name, added, where) => {
      const res = await post('add', {
        data: { orderNo: 'X3', title: 't' },
        children: { items: { added } },
      }).expect(400);
      expect(errorsOf(res)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ resource: 'items', ...where }),
        ]),
      );
      expect(await counts()).toEqual([0, 0]);
    });

    it.each([
      ['外键 orderId', { orderId: '1' }],
      ['租户 tenantId', { tenantId: '2' }],
      ['编号 id', { id: '1' }],
      ['没声明的字段', { foo: 1 }],
    ])(
      '新增行里带%s：400，不能借此挂到别的单据或改系统字段',
      async (_name, extra) => {
        const res = await post('add', {
          data: { orderNo: 'X4', title: 't' },
          children: { items: { added: [item('a', 'P1', 1, extra)] } },
        }).expect(400);
        expect(errorsOf(res)[0]).toMatchObject({
          resource: 'items',
          clientId: 'a',
        });
      },
    );

    it('新增时子表不能提交 updated / deleted；不认识的子表 400', async () => {
      const a = await post('add', {
        data: { orderNo: 'X5', title: 't' },
        children: { items: { added: [item('a', 'P1')], deleted: ['1'] } },
      }).expect(400);
      expect(errorsOf(a)).toEqual([
        expect.objectContaining({ resource: 'items', field: 'deleted' }),
      ]);
      const b = await post('add', {
        data: { orderNo: 'X6', title: 't' },
        children: {
          items: { added: [item('a', 'P1')] },
          ghosts: { added: [] },
        },
      }).expect(400);
      expect(errorsOf(b)).toEqual([
        expect.objectContaining({ field: 'children.ghosts' }),
      ]);
    });

    it('同一张单据里商品重复：400，标出每一条重复的新增行', async () => {
      const res = await post('add', {
        data: { orderNo: 'X7', title: 't' },
        children: { items: { added: [item('a', 'P1'), item('b', 'P1')] } },
      }).expect(400);
      expect(
        errorsOf(res)
          .map((e) => e.clientId)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['a', 'b']);
      expect(errorsOf(res)[0].messages[0]).toBe('同一张单据里商品不能重复');
    });

    it('超过最多行数：400', async () => {
      const added = ['1', '2', '3', '4', '5', '6'].map((n) => item(n, `P${n}`));
      const res = await post('add', {
        data: { orderNo: 'X8', title: 't' },
        children: { items: { added } },
      }).expect(400);
      expect(errorsOf(res)).toEqual([
        expect.objectContaining({ resource: 'items', field: '_rows' }),
      ]);
    });
  });

  describe('空白 clientId', () => {
    it.each([
      ['三个空格', ['   ']],
      ['制表符', ['\t']],
      ['两行都是空白', ['  ', '  ']],
    ])('%s：按 index 定位，整个保存被拒', async (_name, ids) => {
      const added = ids.map((clientId, n) => item(clientId, `P${n}`));
      const res = await post('add', {
        data: { orderNo: 'WS', title: 't' },
        children: { items: { added } },
      }).expect(400);
      expect(
        errorsOf(res)
          .filter((e) => e.field === 'clientId')
          .map((e) => e.index),
      ).toEqual(ids.map((_, n) => n));
      expect(await counts()).toEqual([0, 0]);
    });

    it('修改时新增行 clientId 为空白：被拒，版本号不变', async () => {
      const order = await create([item('a', 'P1')]);
      await post('update', {
        id: order.id,
        version: 1,
        data: {},
        children: { items: { added: [item(' ', 'P2')] } },
      }).expect(400);
      const [m] = await ds.query(
        'SELECT version FROM demo_order WHERE id = ?',
        [order.id],
      );
      expect(m.version).toBe(1);
    });
  });

  describe('唯一字段的默认值', () => {
    const tag = (clientId: string, extra: object) => ({ clientId, ...extra });
    const addWithTags = (tags: object[]) =>
      post('add', {
        data: {
          orderNo: `T-${Math.random().toString(36).slice(2, 8)}`,
          title: 't',
        },
        children: {
          items: { added: [item('i', 'P1')] },
          tags: { added: tags },
        },
      });

    it('两条新增都省略常量默认值字段（级别默认 0）：写入前就发现重复，按 clientId 定位', async () => {
      const res = await addWithTags([
        tag('a', { label: 'x', code: 'c1' }),
        tag('b', { label: 'y', code: 'c2' }),
      ]).expect(400);
      expect(
        errorsOf(res).map((e) => [e.resource, e.clientId, e.field]),
      ).toEqual([
        ['tags', 'a', 'level'],
        ['tags', 'b', 'level'],
      ]);
      expect(await counts()).toEqual([0, 0]);
    });

    it('组合唯一里有 SQL 表达式默认值（代码默认 none）：写入后复核发现重复，整批回滚', async () => {
      const res = await addWithTags([
        tag('a', { label: 'x', level: 1 }),
        tag('b', { label: 'x', level: 2 }),
      ]).expect(400);
      expect(
        errorsOf(res)
          .map((e) => e.clientId)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['a', 'b']);
      expect(errorsOf(res)[0]).toMatchObject({
        resource: 'tags',
        field: 'code',
        messages: ['同一张单据里代码、名称不能重复'],
      });
      expect(await counts()).toEqual([0, 0]);
      const [{ n }] = await ds.query('SELECT COUNT(*) n FROM demo_order_tag');
      expect(Number(n)).toBe(0);
    });

    it('新增行省略默认值字段，和已有行的默认值重复：被拒，已有行用 id 定位，版本号不变', async () => {
      const res = await addWithTags([
        tag('a', { label: 'x', code: 'c1' }),
      ]).expect(200);
      const order = res.body.data;
      const existing = order.children.tags[0].id;
      const bad = await post('update', {
        id: order.id,
        version: 1,
        data: {},
        children: { tags: { added: [tag('n', { label: 'y', code: 'c2' })] } },
      }).expect(400);
      expect(errorsOf(bad)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resource: 'tags',
            id: existing,
            field: 'level',
          }),
          expect.objectContaining({
            resource: 'tags',
            clientId: 'n',
            field: 'level',
          }),
        ]),
      );
      const [m] = await ds.query(
        'SELECT version FROM demo_order WHERE id = ?',
        [order.id],
      );
      expect(m.version).toBe(1);
      // 显式给不同的值就可以
      await post('update', {
        id: order.id,
        version: 1,
        data: {},
        children: {
          tags: { added: [tag('n', { label: 'y', code: 'c2', level: 5 })] },
        },
      }).expect(200);
    });

    it('数据库排序规则下视为相同的值（大小写不同）：写入后复核发现重复', async () => {
      const res = await addWithTags([
        tag('a', { label: 'X', level: 1, code: 'k' }),
        tag('b', { label: 'x', level: 2, code: 'k' }),
      ]).expect(400);
      expect(
        errorsOf(res)
          .map((e) => e.clientId)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['a', 'b']);
      expect(await counts()).toEqual([0, 0]);
    });
  });

  describe('修改（三组差异）', () => {
    it('新增、修改、删除一起提交；主表版本号加 1；没提交的明细保持不动', async () => {
      const order = await create([
        item('a', 'P1'),
        item('b', 'P2'),
        item('c', 'P3'),
      ]);
      const [p1, p2, p3] = order.children.items;
      const res = await post('update', {
        id: order.id,
        version: 1,
        data: {},
        children: {
          items: {
            added: [item('n', 'P9', 9)],
            updated: [{ id: p2.id, qty: 5 }],
            deleted: [p1.id],
          },
          notes: { added: [{ clientId: 'x', content: '加急' }] },
        },
      }).expect(200);
      expect(res.body.data.version).toBe(2);
      const items = res.body.data.children.items as {
        id: string;
        productCode: string;
        qty: number;
      }[];
      expect(items.map((r) => [r.productCode, r.qty])).toEqual(
        expect.arrayContaining([
          ['P2', 5],
          ['P3', 1],
          ['P9', 9],
        ]),
      );
      expect(items).toHaveLength(3);
      expect(items.find((r) => r.id === p3.id)).toMatchObject({
        productCode: 'P3',
        qty: 1,
      });
      expect(res.body.data.children.notes).toEqual([
        expect.objectContaining({ content: '加急' }),
      ]);
      // 被删的明细软删除：数据还在库里
      const [db] = await ds.query(
        'SELECT deleted_at FROM demo_order_item WHERE id = ?',
        [p1.id],
      );
      expect(db.deleted_at).not.toBeNull();
    });

    it('只加载了部分明细就保存：没提交的明细不会被清空', async () => {
      const order = await create([item('a', 'P1'), item('b', 'P2')]);
      const [, p2] = order.children.items;
      await post('update', {
        id: order.id,
        version: 1,
        data: { title: '只改标题和一行' },
        children: { items: { updated: [{ id: p2.id, remark: '改过' }] } },
      }).expect(200);
      const info = await post('info', { id: order.id });
      expect(info.body.data.children.items).toHaveLength(2);
      expect(info.body.data.title).toBe('只改标题和一行');
    });

    it('只改主表不提交子表：子表不动，但行数下限不受影响', async () => {
      const order = await create([item('a', 'P1')]);
      await post('update', {
        id: order.id,
        version: 1,
        data: { title: '新' },
      }).expect(200);
      const info = await post('info', { id: order.id });
      expect(info.body.data.children.items).toHaveLength(1);
    });

    it('提交别的单据的明细 ID：400，和不存在的 ID 错误一样，什么都不改', async () => {
      const mine = await create([item('a', 'P1')]);
      const other = await create([item('a', 'P1')]);
      const otherItem = other.children.items[0].id;
      const a = await post('update', {
        id: mine.id,
        version: 1,
        data: {},
        children: { items: { updated: [{ id: otherItem, qty: 99 }] } },
      }).expect(400);
      const b = await post('update', {
        id: mine.id,
        version: 1,
        data: {},
        children: { items: { updated: [{ id: '999999', qty: 99 }] } },
      }).expect(400);
      expect(errorsOf(a)[0]).toMatchObject({
        resource: 'items',
        id: otherItem,
        field: 'id',
      });
      expect(errorsOf(a)[0].messages).toEqual(errorsOf(b)[0].messages);
      const del = await post('update', {
        id: mine.id,
        version: 1,
        data: {},
        children: { items: { deleted: [otherItem] } },
      }).expect(400);
      expect(errorsOf(del)[0]).toMatchObject({
        id: otherItem,
        messages: ['明细不存在或不属于这张单据'],
      });
      const [row] = await ds.query(
        'SELECT qty, deleted_at FROM demo_order_item WHERE id = ?',
        [otherItem],
      );
      expect(row).toMatchObject({ qty: 1, deleted_at: null });
      const [m] = await ds.query(
        'SELECT version FROM demo_order WHERE id = ?',
        [mine.id],
      );
      expect(m.version).toBe(1);
    });

    it('提交别的租户的明细 ID：和不存在一样', async () => {
      const mine = await create([item('a', 'P1')]);
      const r = await ds.query(
        "INSERT INTO demo_order_item (tenant_id, order_id, product_code, qty, version) VALUES (2, ?, 'PX', 1, 1)",
        [mine.id],
      );
      const foreign = String((r as { insertId: number }).insertId);
      const res = await post('update', {
        id: mine.id,
        version: 1,
        data: {},
        children: { items: { deleted: [foreign] } },
      }).expect(400);
      expect(errorsOf(res)[0]).toMatchObject({
        id: foreign,
        messages: ['明细不存在或不属于这张单据'],
      });
      const info = await post('info', { id: mine.id });
      expect(info.body.data.children.items).toHaveLength(1);
    });

    it('同一行既修改又删除、或在 updated 里出现两次：400', async () => {
      const order = await create([item('a', 'P1'), item('b', 'P2')]);
      const [p1] = order.children.items;
      const a = await post('update', {
        id: order.id,
        version: 1,
        data: {},
        children: {
          items: { updated: [{ id: p1.id, qty: 3 }], deleted: [p1.id] },
        },
      }).expect(400);
      expect(errorsOf(a)[0]).toMatchObject({
        id: p1.id,
        messages: ['同一行不能同时修改和删除'],
      });
      await post('update', {
        id: order.id,
        version: 1,
        data: {},
        children: {
          items: {
            updated: [
              { id: p1.id, qty: 3 },
              { id: p1.id, qty: 4 },
            ],
          },
        },
      }).expect(400);
    });

    it('唯一检查按保存后的结果：两行互换商品可以，新增一行和已有行重复不行', async () => {
      const order = await create([item('a', 'P1'), item('b', 'P2')]);
      const [x, y] = order.children.items;
      await post('update', {
        id: order.id,
        version: 1,
        data: {},
        children: {
          items: {
            updated: [
              { id: x.id, productCode: y.productCode },
              { id: y.id, productCode: x.productCode },
            ],
          },
        },
      }).expect(200);
      const dup = await post('update', {
        id: order.id,
        version: 2,
        data: {},
        children: { items: { added: [item('n', 'P1')] } },
      }).expect(400);
      expect(errorsOf(dup)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ clientId: 'n', field: 'productCode' }),
        ]),
      );
    });

    it('删到少于最少行数：400', async () => {
      const order = await create([item('a', 'P1')]);
      const res = await post('update', {
        id: order.id,
        version: 1,
        data: {},
        children: { items: { deleted: [order.children.items[0].id] } },
      }).expect(400);
      expect(errorsOf(res)).toEqual([
        expect.objectContaining({ resource: 'items', field: '_rows' }),
      ]);
    });

    it('明细非空字段传 null：400；可空字段传 null 清空', async () => {
      const order = await create([item('a', 'P1', 1, { remark: '有' })]);
      const id = order.children.items[0].id;
      const bad = await post('update', {
        id: order.id,
        version: 1,
        data: {},
        children: { items: { updated: [{ id, qty: null }] } },
      }).expect(400);
      expect(errorsOf(bad)[0]).toMatchObject({
        resource: 'items',
        id,
        field: 'qty',
      });
      const ok = await post('update', {
        id: order.id,
        version: 1,
        data: {},
        children: { items: { updated: [{ id, remark: null }] } },
      }).expect(200);
      expect(ok.body.data.children.items[0].remark).toBeNull();
    });

    it('修改行里带外键：400，不能把明细挂到别的单据上', async () => {
      const order = await create([item('a', 'P1')]);
      const other = await create([item('a', 'P1')]);
      await post('update', {
        id: order.id,
        version: 1,
        data: {},
        children: {
          items: {
            updated: [{ id: order.children.items[0].id, orderId: other.id }],
          },
        },
      }).expect(400);
    });

    it('两人同时只改明细（同一个版本号）：只有一个成功，另一个 409，失败方的改动一条不留', async () => {
      const order = await create([item('a', 'P1'), item('b', 'P2')]);
      const [p1, p2] = order.children.items;
      const results = await Promise.all([
        post('update', {
          id: order.id,
          version: 1,
          data: {},
          children: { items: { updated: [{ id: p1.id, qty: 11 }] } },
        }),
        post('update', {
          id: order.id,
          version: 1,
          data: {},
          children: {
            items: {
              updated: [{ id: p2.id, qty: 22 }],
              added: [item('z', 'P7')],
            },
          },
        }),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      const info = await post('info', { id: order.id });
      expect(info.body.data.version).toBe(2);
      const winner = results.findIndex((r) => r.status === 200);
      const items = info.body.data.children.items as {
        productCode: string;
        qty: number;
      }[];
      if (winner === 0)
        expect(items.map((r) => [r.productCode, r.qty])).toEqual([
          ['P1', 11],
          ['P2', 1],
        ]);
      else
        expect(
          items.map((r) => r.productCode).sort((a, b) => a.localeCompare(b)),
        ).toEqual(['P1', 'P2', 'P7']);
    });
  });

  describe('并发', () => {
    it('多张单据同时新增、同时修改明细：全部成功，不会互相死锁', async () => {
      const orders = await Promise.all(
        Array.from({ length: 8 }, (_, n) =>
          create([item('a', `P${n}`), item('b', `Q${n}`)]),
        ),
      );
      const results = await Promise.all(
        orders.map((o, n) =>
          post('update', {
            id: o.id,
            version: 1,
            data: {},
            children: {
              items: {
                added: [item('c', `R${n}`)],
                updated: [{ id: o.children.items[0].id, qty: 7 }],
                deleted: [o.children.items[1].id],
              },
            },
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
      const [{ n }] = await ds.query(
        'SELECT COUNT(*) n FROM demo_order_item WHERE deleted_at IS NULL',
      );
      expect(Number(n)).toBe(16);
    });
  });

  describe('删除主表', () => {
    it('子表跟随主表软删除；分页不带子表', async () => {
      const order = await create([item('a', 'P1'), item('b', 'P2')]);
      const page = await post('page', {}).expect(200);
      expect(page.body.data.list[0]).not.toHaveProperty('children');
      await post('delete', { ids: [order.id] }).expect(200);
      const rows = await ds.query(
        'SELECT deleted_at FROM demo_order_item WHERE order_id = ?',
        [order.id],
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.deleted_at).not.toBeNull();
    });
  });

  describe('接口文档', () => {
    it('子表的请求和响应模型都在文档里，全部本地 $ref 都能解析', () => {
      const doc = buildOpenApiDocument(app, APP_VERSION);
      const schemas = doc.components?.schemas ?? {};
      for (const name of [
        'TestDemoOrderAddChildren',
        'TestDemoOrderUpdateChildren',
        'TestDemoOrderItemsAddRow',
        'TestDemoOrderItemsUpdateRow',
        'TestDemoOrderItemsChange',
        'TestDemoOrderItemsRow',
        'TestDemoOrderDetail',
        'TestDemoOrderNotesChange',
      ])
        expect(schemas).toHaveProperty(name);
      const addRow = schemas.TestDemoOrderItemsAddRow as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(
        Object.keys(addRow.properties).sort((a, b) => a.localeCompare(b)),
      ).toEqual(['clientId', 'productCode', 'qty', 'remark', 'sort']);
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
      const missing = [...refs].filter(
        (r) => !(r.replace('#/components/schemas/', '') in schemas),
      );
      expect(missing).toEqual([]);
      const update = (
        doc.paths['/admin/test/demo-order/update'] as {
          post: { responses: Record<string, unknown> };
        }
      ).post;
      expect(
        Object.keys(update.responses).sort((a, b) => a.localeCompare(b)),
      ).toEqual(['200', '400', '404', '409']);
    });
  });

  describe('页面描述', () => {
    it('带子表的列、表单、行数、唯一和可写字段', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/test/demo-order/schema')
        .expect(200);
      const [items, notes] = res.body.data.children;
      expect(items).toMatchObject({
        resource: 'items',
        label: '订单明细',
        min: 1,
        max: 5,
        unique: [['productCode']],
        sortField: 'sort',
      });
      expect(items.add.writable).toEqual([
        'productCode',
        'qty',
        'sort',
        'remark',
      ]);
      expect(items.columns.map((c: { field: string }) => c.field)).toEqual([
        'productCode',
        'qty',
        'sort',
        'remark',
        'createdBy',
        'createdAt',
        'updatedBy',
        'updatedAt',
        'orgId',
        'id',
      ]);
      expect(notes).toMatchObject({
        resource: 'notes',
        min: 0,
        max: 500,
        unique: [],
      });
    });
  });
});

describe('子表只有主表一个写入口', () => {
  it('子表实体自己开放修改接口：启动失败', async () => {
    const moduleRef = await createTestModule({
      imports: [AppModule, TypeOrmModule.forFeature(ENTITIES)],
      controllers: [DemoOrderController, DemoOrderItemWriteController],
    }).compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await expect(app.init()).rejects.toThrow(
      /是 test\/demo-order 的子表，不能开放 update 接口/,
    );
    await app.close().catch(() => undefined);
  });
});

describe('子表只有主表一个写入口：Service 层', () => {
  // 两种注册顺序都要拦住
  it.each([
    ['先注册主表', [DemoOrderController, DemoOrderItemReadController]],
    ['先注册只读子表资源', [DemoOrderItemReadController, DemoOrderController]],
  ])(
    '%s：只读子表资源可以查，但它的 Service 新增、修改、删除都被拒，数据不变',
    async (_name, controllers) => {
      const moduleRef = await createTestModule({
        imports: [AppModule, TypeOrmModule.forFeature(ENTITIES)],
        controllers,
        providers: [DemoOrderItemReadService],
      }).compile();
      const app = moduleRef.createNestApplication();
      configureApp(app);
      await app.init();
      try {
        const ds = app.get(DataSource);
        for (const t of [
          'demo_order_tag',
          'demo_order_note',
          'demo_order_item',
          'demo_order',
        ])
          await ds.query(`DELETE FROM ${t}`);
        const created = await request(app.getHttpServer())
          .post('/admin/test/demo-order/add')
          .send({
            data: { orderNo: 'G1', title: 't' },
            children: {
              items: { added: [{ clientId: 'a', productCode: 'P1', qty: 1 }] },
            },
          })
          .expect(200);
        const order = created.body.data;
        const itemId = order.children.items[0].id;
        await request(app.getHttpServer())
          .post('/admin/test/demo-order-item-read/info')
          .send({ id: itemId })
          .expect(200);

        const svc = app.get(DemoOrderItemReadService);
        const owner = /只能通过 test\/demo-order 的新增、修改一起保存/;
        await expect(svc.update(itemId, 1, { qty: 99 })).rejects.toThrow(owner);
        await expect(
          svc.add({ orderId: order.id, productCode: 'P2', qty: 1 } as never),
        ).rejects.toThrow(owner);
        await expect(svc.delete([itemId])).rejects.toThrow(owner);

        const [row] = await ds.query(
          'SELECT qty, deleted_at FROM demo_order_item WHERE id = ?',
          [itemId],
        );
        expect(row).toMatchObject({ qty: 1, deleted_at: null });
        const [{ n }] = await ds.query(
          'SELECT COUNT(*) n FROM demo_order_item',
        );
        expect(Number(n)).toBe(1);
        const [m] = await ds.query(
          'SELECT version FROM demo_order WHERE id = ?',
          [order.id],
        );
        expect(m.version).toBe(1);
      } finally {
        await app.close();
      }
    },
  );
});
