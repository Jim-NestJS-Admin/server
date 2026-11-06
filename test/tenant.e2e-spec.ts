import {
  Body,
  HttpCode,
  HttpStatus,
  Injectable,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AdminAuth } from '../src/core/endpoint/endpoint-auth.js';
import {
  AdminController,
  IgnoreTenant,
} from '../src/core/endpoint/endpoint.decorators.js';
import { BusinessException } from '../src/core/exceptions/business.exception.js';
import { ErrorCode } from '../src/core/exceptions/error-code.js';
import {
  MissingContextError,
  RequestContext,
  type Principal,
} from '../src/core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../src/core/tenant/tenant-repository.js';
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

/** 测试用后台认证：从请求头取租户和用户，代替 T05 的正式登录；没带就是没登录 */
@Injectable()
class HeaderAdminAuth extends AdminAuth {
  async authenticate(req: Request): Promise<Principal> {
    const tenantId = req.header('x-test-tenant');
    if (!tenantId)
      throw new BusinessException(
        ErrorCode.Unauthorized,
        '请先登录',
        HttpStatus.UNAUTHORIZED,
      );
    return { tenantId, userId: req.header('x-test-user') ?? null, orgId: null };
  }
}

/** 平台接口和租户感知 Repository 的演示 */
@AdminController('test/platform')
class PlatformController {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly users: DemoUserService,
  ) {}

  @HttpCode(200)
  @Post('users')
  @IgnoreTenant()
  async allUsers() {
    const rows = await this.repos
      .for(DemoUserEntity)
      .query()
      .orderBy('e.id', 'ASC')
      .getMany();
    return rows.map((r) => ({ username: r.username, tenantId: r.tenantId }));
  }

  @HttpCode(200)
  @Post('write')
  @IgnoreTenant()
  async writeAcross() {
    return this.users.add({ username: 'cross', nickname: 'x' });
  }

  @HttpCode(200)
  @Post('repo')
  async repo(@Body() body: { message: string }) {
    const repo = this.repos.for(DemoLogEntity);
    const id = await repo.insert({
      message: body.message,
      tenantId: '9',
      createdBy: '999',
    } as never);
    const updated = await repo.update([id], {
      message: `${body.message}!`,
      tenantId: '9',
    } as never);
    const rows = await repo.query().getMany();
    return {
      id,
      updated,
      rows: rows.map((r) => ({
        id: r.id,
        message: r.message,
        tenantId: r.tenantId,
        createdBy: r.createdBy,
      })),
    };
  }

  @HttpCode(200)
  @Post('repo-remove')
  async repoRemove(@Body() body: { ids: string[] }) {
    return { removed: await this.repos.for(DemoLogEntity).remove(body.ids) };
  }
}

/**
 * T04：租户上下文、租户感知 Repository、@IgnoreTenant、多端认证守卫。
 * 防漏测试（架构「多租户设计」）：A 租户的登录访问 B 租户的数据，必须全部失败，而且和「不存在」分不出来。
 */
describe('多租户隔离（T04）', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  let context: RequestContext;
  const as = (tenant: string | null, path: string, body: unknown = {}) => {
    const r = request(app.getHttpServer()).post(path);
    if (tenant)
      r.set('x-test-tenant', tenant).set(
        'x-test-user',
        tenant === '0' ? '100' : `${tenant}0`,
      );
    return r.send(body as object);
  };
  const user = (tenant: string, action: string, body: unknown = {}) =>
    as(tenant, `/admin/test/demo-user/${action}`, body);
  const order = (tenant: string, action: string, body: unknown = {}) =>
    as(tenant, `/admin/test/demo-order/${action}`, body);

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
      controllers: [
        DemoUserController,
        DemoLogController,
        DemoOrderController,
        PlatformController,
      ],
      providers: [DemoUserService],
    })
      .overrideProvider(AdminAuth)
      .useClass(HeaderAdminAuth)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    context = app.get(RequestContext);
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
  });

  it('没登录：401，到不了业务代码', async () => {
    const res = await as(null, '/admin/test/demo-user/page').expect(401);
    expect(res.body.code).toBe(4001);
  });

  it('写入的租户和创建人来自登录身份，不是请求体', async () => {
    const res = await user('2', 'add', {
      data: { username: 'uu', nickname: 'n' },
    }).expect(200);
    const [db] = await ds.query(
      'SELECT tenant_id, created_by FROM demo_user WHERE id = ?',
      [res.body.data.id],
    );
    expect(db).toEqual({ tenant_id: '2', created_by: '20' });
    expect(res.body.data.createdBy).toBe('20');
  });

  it('同名账号在不同租户各自有效', async () => {
    await user('1', 'add', {
      data: { username: 'same', nickname: 'a' },
    }).expect(200);
    await user('2', 'add', {
      data: { username: 'same', nickname: 'b' },
    }).expect(200);
    const p1 = await user('1', 'page').expect(200);
    expect(
      p1.body.data.list.map((r: { nickname: string }) => r.nickname),
    ).toEqual(['a']);
  });

  describe('防漏：B 租户访问 A 租户的数据全部失败，响应和不存在一样', () => {
    let aUser: { id: string; version: number };
    let aOrder: {
      id: string;
      version: number;
      children: { items: { id: string }[] };
    };

    beforeEach(async () => {
      aUser = (
        await user('1', 'add', {
          data: { username: 'alice', nickname: 'A' },
        }).expect(200)
      ).body.data;
      aOrder = (
        await order('1', 'add', {
          data: { orderNo: 'A-1', title: 'A' },
          children: {
            items: { added: [{ clientId: 'x', productCode: 'P1', qty: 1 }] },
          },
        }).expect(200)
      ).body.data;
    });

    it.each([
      ['详情', 'info', (id: string) => ({ id })],
      [
        '修改',
        'update',
        (id: string) => ({ id, version: 1, data: { nickname: '改' } }),
      ],
      ['删除', 'delete', (id: string) => ({ ids: [id] })],
    ])('用户%s', async (_name, action, body) => {
      const foreign = await user('2', action, body(aUser.id)).expect(404);
      const missing = await user('2', action, body('999999')).expect(404);
      expect(foreign.body).toEqual(missing.body);
    });

    it('分页、回收站列表看不到；恢复、彻底删除 404', async () => {
      const page = await user('2', 'page').expect(200);
      expect(page.body.data.total).toBe(0);
      await user('1', 'delete', { ids: [aUser.id] }).expect(200);
      const recycle = await user('2', 'recycle/page').expect(200);
      expect(recycle.body.data.total).toBe(0);
      for (const action of ['restore', 'purge']) {
        const foreign = await user('2', action, {
          items: [{ id: aUser.id, version: 2 }],
        }).expect(404);
        const missing = await user('2', action, {
          items: [{ id: '999999', version: 2 }],
        }).expect(404);
        expect(foreign.body).toEqual(missing.body);
      }
      const [db] = await ds.query(
        'SELECT deleted_at FROM demo_user WHERE id = ?',
        [aUser.id],
      );
      expect(db.deleted_at).not.toBeNull();
    });

    it('主子表：改不了别的租户的单据和明细，A 的数据一条没变', async () => {
      await order('2', 'info', { id: aOrder.id }).expect(404);
      await order('2', 'update', {
        id: aOrder.id,
        version: 1,
        data: {},
        children: { items: { deleted: [aOrder.children.items[0].id] } },
      }).expect(404);
      const mine = (
        await order('2', 'add', {
          data: { orderNo: 'B-1', title: 'B' },
          children: {
            items: { added: [{ clientId: 'y', productCode: 'P1', qty: 1 }] },
          },
        }).expect(200)
      ).body.data;
      const res = await order('2', 'update', {
        id: mine.id,
        version: 1,
        data: {},
        children: {
          items: { updated: [{ id: aOrder.children.items[0].id, qty: 99 }] },
        },
      }).expect(400);
      expect(res.body.data.errors[0].messages).toEqual([
        '明细不存在或不属于这张单据',
      ]);
      const [item] = await ds.query(
        'SELECT qty, deleted_at FROM demo_order_item WHERE id = ?',
        [aOrder.children.items[0].id],
      );
      expect(item).toMatchObject({ qty: 1, deleted_at: null });
      const [m] = await ds.query(
        'SELECT version FROM demo_order WHERE id = ?',
        [aOrder.id],
      );
      expect(m.version).toBe(1);
    });
  });

  describe('@IgnoreTenant 跨租户', () => {
    beforeEach(async () => {
      await user('1', 'add', {
        data: { username: 'one', nickname: 'x' },
      }).expect(200);
      await user('2', 'add', {
        data: { username: 'two', nickname: 'x' },
      }).expect(200);
    });

    it('普通租户调用：403', async () => {
      const res = await as('1', '/admin/test/platform/users').expect(403);
      expect(res.body.code).toBe(4003);
    });

    it('平台租户：能查到所有租户的数据', async () => {
      const res = await as('0', '/admin/test/platform/users').expect(200);
      expect(res.body.data).toEqual([
        { username: 'one', tenantId: '1' },
        { username: 'two', tenantId: '2' },
      ]);
    });

    it('跨租户模式只能读：写入被拒，什么都没写', async () => {
      await as('0', '/admin/test/platform/write').expect(500);
      const [{ n }] = await ds.query(
        "SELECT COUNT(*) n FROM demo_user WHERE username = 'cross'",
      );
      expect(Number(n)).toBe(0);
    });
  });

  describe('租户感知 Repository', () => {
    it('插入、更新、查询都只在当前租户，传进来的租户和创建人被忽略', async () => {
      await ds.query(
        "INSERT INTO demo_log (tenant_id, message, version) VALUES (3, 'other', 1)",
      );
      const res = await as('3', '/admin/test/platform/repo', {
        message: 'hi',
      }).expect(200);
      const { id, updated, rows } = res.body.data;
      expect(updated).toBe(1);
      expect(rows).toEqual(
        expect.arrayContaining([
          { id, message: 'hi!', tenantId: '3', createdBy: '30' },
        ]),
      );
      const other = await as('4', '/admin/test/platform/repo', {
        message: 'x',
      }).expect(200);
      expect(
        other.body.data.rows.map((r: { message: string }) => r.message),
      ).toEqual(['x!']);
      const gone = await as('4', '/admin/test/platform/repo-remove', {
        ids: [id],
      }).expect(200);
      expect(gone.body.data.removed).toBe(0);
      const mine = await as('3', '/admin/test/platform/repo-remove', {
        ids: [id],
      }).expect(200);
      expect(mine.body.data.removed).toBe(1);
    });
  });

  describe('写入保险（TenantGuardSubscriber）', () => {
    it('没有上下文：经 TypeORM 写带租户的表直接报错', async () => {
      await expect(
        ds.manager.insert(DemoLogEntity, { message: 'no-ctx' }),
      ).rejects.toThrow(MissingContextError);
    });

    it('往别的租户写、或者改租户：报错', async () => {
      await expect(
        context.run({ tenantId: '1' }, () =>
          ds.manager.insert(DemoLogEntity, { message: 'x', tenantId: '2' }),
        ),
      ).rejects.toThrow(/不能往别的租户写数据/);
      const id = await context.run({ tenantId: '1' }, async () => {
        const r = await ds.manager.insert(DemoLogEntity, { message: 'ok' });
        return String(r.identifiers[0].id);
      });
      const [db] = await ds.query(
        'SELECT tenant_id FROM demo_log WHERE id = ?',
        [id],
      );
      expect(db.tenant_id).toBe('1');
      await expect(
        context.run({ tenantId: '1' }, () =>
          ds.manager.update(DemoLogEntity, id, { tenantId: '2' }),
        ),
      ).rejects.toThrow(/不能修改/);
    });

    it('后台任务在 run 里用通用 CRUD：按指定租户读写', async () => {
      const svc = app.get(DemoUserService);
      await expect(svc.page({})).rejects.toThrow(MissingContextError);
      const row = await context.run({ tenantId: '6' }, () =>
        svc.add({ username: 'job', nickname: 'job' }),
      );
      const [db] = await ds.query(
        'SELECT tenant_id FROM demo_user WHERE id = ?',
        [row.id],
      );
      expect(db.tenant_id).toBe('6');
    });
  });
});
