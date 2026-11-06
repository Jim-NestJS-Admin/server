import {
  HttpCode,
  Injectable,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IsString, Length } from 'class-validator';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { Column, DataSource, Entity } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  BaseController,
  BaseEntity,
  BaseService,
  CrudController,
  CrudField,
} from '../src/core/crud/index.js';
import { AdminAuth } from '../src/core/endpoint/endpoint-auth.js';
import {
  PermissionSource,
  type MenuNode,
  type OrgNode,
  type RoleGrant,
} from '../src/core/permission/permission-source.js';
import { PermissionService } from '../src/core/permission/permission.service.js';
import { LoginOnly, Perms } from '../src/core/permission/perms.decorator.js';
import { TestAdminAuth } from './support/test-auth.js';
import { clearTestRedis, rawRedis } from './support/test-redis.js';

@Entity('demo_customer')
class DemoCustomerEntity extends BaseEntity {
  @CrudField({ label: '名称', form: { required: true } })
  @IsString()
  @Length(1, 50)
  @Column({ type: 'varchar', length: 50 })
  name: string;
}

@Injectable()
class DemoCustomerService extends BaseService<DemoCustomerEntity> {
  /** 自定义接口用 select() 查数据：数据范围同样生效 */
  async names(): Promise<string[]> {
    const rows = await this.select(this.crud.dataSource.manager, 'page')
      .orderBy('e.name', 'ASC')
      .getMany();
    return rows.map((r) => r.name);
  }
}

@CrudController({
  prefix: 'test/customer',
  label: '演示客户',
  entity: DemoCustomerEntity,
  api: ['page', 'info', 'add', 'update', 'delete'],
  service: DemoCustomerService,
  dataScope: true,
})
class DemoCustomerController extends BaseController<DemoCustomerEntity> {
  constructor(private readonly customers: DemoCustomerService) {
    super();
  }

  @Post('audit')
  @HttpCode(200)
  @Perms('test:customer:audit')
  audit() {
    return this.customers.names();
  }

  /** 登录即可的接口没有算数据范围：查数据范围资源时什么都看不到 */
  @Post('peek')
  @HttpCode(200)
  @LoginOnly()
  peek() {
    return this.customers.names();
  }
}

/** 组织树：集团 1 → 澳洲 10 → 澳洲销售部 11；集团 1 → 新加坡 20 */
const ORGS: OrgNode[] = [
  { id: '1', parentId: null },
  { id: '10', parentId: '1' },
  { id: '11', parentId: '10' },
  { id: '20', parentId: '1' },
];
const MENUS: MenuNode[] = [
  {
    id: 'd1',
    parentId: null,
    type: 'directory',
    path: '/crm',
    title: '客户',
    rank: 2,
  },
  {
    id: 'p1',
    parentId: 'd1',
    type: 'page',
    path: '/crm/customer',
    title: '客户列表',
    rank: 1,
    component: 'crm/customer/index',
    permission: 'test:customer:page',
  },
  {
    id: 'b1',
    parentId: 'p1',
    type: 'button',
    path: '',
    title: '修改',
    rank: 1,
    permission: 'test:customer:update',
  },
  {
    id: 'd2',
    parentId: null,
    type: 'directory',
    path: '/audit',
    title: '审计',
    rank: 1,
  },
  {
    id: 'p2',
    parentId: 'd2',
    type: 'page',
    path: '/audit/x',
    title: '审计页',
    rank: 1,
    permission: 'test:customer:audit',
  },
  {
    id: 'p3',
    parentId: null,
    type: 'page',
    path: '/welcome',
    title: '欢迎',
    rank: 0,
  },
];
const grants = new Map<string, RoleGrant[]>();

@Injectable()
class FakePermissionSource extends PermissionSource {
  calls = 0;
  async loadGrants(_t: string, userId: string) {
    this.calls++;
    return structuredClone(grants.get(userId) ?? []);
  }
  async loadOrgs() {
    return ORGS;
  }
  async loadMenus() {
    return MENUS;
  }
}

const P = (...actions: string[]) => actions.map((a) => `test:customer:${a}`);

describe('权限（T06）', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  let raw: Redis;

  /** 以某个用户、某个当前组织的身份请求 */
  const as = (
    user: string,
    org: string | null,
    path: string,
    body: object = {},
  ) => {
    const r = request(app.getHttpServer())
      .post(`/admin/test/customer/${path}`)
      .set('x-test-user', user);
    if (org) r.set('x-test-org', org);
    return r.send(body);
  };
  const names = async (user: string, org: string | null) =>
    (
      (await as(user, org, 'page', { page: 1, size: 100 }).expect(200)).body
        .data.list as { name: string }[]
    )
      .map((r) => r.name)
      .sort();
  const seed = async (name: string, orgId: string, createdBy = '9') => {
    await ds.query(
      'INSERT INTO demo_customer (tenant_id, org_id, created_by, name, version) VALUES (1, ?, ?, ?, 1)',
      [orgId, createdBy, name],
    );
    const [{ id }] = await ds.query(
      'SELECT id FROM demo_customer WHERE name = ?',
      [name],
    );
    return String(id);
  };
  const bump = () => app.get(PermissionService).bumpVersion('1');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, TypeOrmModule.forFeature([DemoCustomerEntity])],
      controllers: [DemoCustomerController],
      providers: [DemoCustomerService],
    })
      .overrideProvider(AdminAuth)
      .useClass(TestAdminAuth)
      .overrideProvider(PermissionSource)
      .useClass(FakePermissionSource)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    raw = rawRedis();
  });

  afterAll(async () => {
    await raw.quit();
    await app.close();
  });

  beforeEach(async () => {
    await clearTestRedis(raw);
    await ds.query('DELETE FROM demo_customer');
    grants.clear();
  });

  describe('本次有效角色：不能跨角色拼接', () => {
    // 小王：「客服」全局角色，能查看全部客户；「经理」在澳洲销售部（11），能查看和修改本部门客户
    beforeEach(() => {
      grants.set('100', [
        {
          roleId: 'cs',
          scopeOrgId: null,
          permissions: P('page', 'info'),
          dataScope: 'all',
        },
        {
          roleId: 'mgr',
          scopeOrgId: '11',
          permissions: P('page', 'info', 'update'),
          dataScope: 'org',
        },
      ]);
    });

    it('查看：客服的范围（全部）', async () => {
      await seed('sales-a', '11');
      await seed('sg-b', '20');
      expect(await names('100', '11')).toEqual(['sales-a', 'sg-b']);
    });

    it('修改别的部门的客户：本次有效角色只有经理，数据范围只有本部门，404；数据没变', async () => {
      const id = await seed('sg-b', '20');
      const res = await as('100', '11', 'update', {
        id,
        version: 1,
        data: { name: 'hacked' },
      }).expect(404);
      expect(res.body.code).toBe(4004);
      const [{ name }] = await ds.query(
        'SELECT name FROM demo_customer WHERE id = ?',
        [id],
      );
      expect(name).toBe('sg-b');
    });

    it('修改本部门客户：允许', async () => {
      const id = await seed('sales-a', '11');
      await as('100', '11', 'update', {
        id,
        version: 1,
        data: { name: 'ok' },
      }).expect(200);
    });

    it('没有任何角色授予这个动作：403', async () => {
      const id = await seed('sales-a', '11');
      expect(
        (await as('100', '11', 'delete', { ids: [id] }).expect(403)).body.code,
      ).toBe(4003);
      await as('100', '11', 'audit').expect(403);
    });
  });

  describe('当前组织', () => {
    // 小李：澳洲（10）能查看本组织及下级；新加坡（20）能查看和新增本组织
    beforeEach(() => {
      grants.set('200', [
        {
          roleId: 'au',
          scopeOrgId: '10',
          permissions: P('page'),
          dataScope: 'org_and_children',
        },
        {
          roleId: 'sg',
          scopeOrgId: '20',
          permissions: P('page', 'add'),
          dataScope: 'org',
        },
      ]);
    });

    it('同一用户在不同组织下权限不同；来回切换不会用到另一个组织的缓存', async () => {
      await seed('au', '10');
      await seed('au-sales', '11');
      await seed('sg', '20');
      expect(await names('200', '10')).toEqual(['au', 'au-sales']);
      await as('200', '10', 'add', { data: { name: 'x' } }).expect(403);
      expect(await names('200', '20')).toEqual(['sg']);
      await as('200', '20', 'add', { data: { name: 'sg-new' } }).expect(200);
      // 切回澳洲：仍然不能新增，看不到新加坡新建的
      await as('200', '10', 'add', { data: { name: 'y' } }).expect(403);
      expect(await names('200', '10')).toEqual(['au', 'au-sales']);
    });

    it('新增时所属组织取当前组织', async () => {
      await as('200', '20', 'add', { data: { name: 'sg-new' } }).expect(200);
      const [{ org_id }] = await ds.query(
        "SELECT org_id FROM demo_customer WHERE name = 'sg-new'",
      );
      expect(String(org_id)).toBe('20');
    });

    it('在当前组织已经没有角色（被移出、角色收回）：401，回登录页重新选组织', async () => {
      await as('200', '20', 'page').expect(200);
      grants.set(
        '200',
        grants.get('200')!.filter((g) => g.scopeOrgId !== '20'),
      );
      await bump();
      expect((await as('200', '20', 'page').expect(401)).body.code).toBe(4001);
      await as('200', '20', 'peek').expect(401);
      await as('200', '10', 'page').expect(200);
    });
  });

  describe('数据范围', () => {
    it('仅本人：只看到自己创建的', async () => {
      grants.set('300', [
        {
          roleId: 'self',
          scopeOrgId: null,
          permissions: P('page'),
          dataScope: 'self',
        },
      ]);
      await seed('mine', '20', '300');
      await seed('theirs', '20', '301');
      expect(await names('300', null)).toEqual(['mine']);
    });

    it('自定义组织', async () => {
      grants.set('300', [
        {
          roleId: 'c',
          scopeOrgId: null,
          permissions: P('page'),
          dataScope: 'custom',
          customOrgIds: ['11', '20'],
        },
      ]);
      await seed('au', '10');
      await seed('au-sales', '11');
      await seed('sg', '20');
      expect(await names('300', null)).toEqual(['au-sales', 'sg']);
    });

    it('自定义接口用 select() 同样按数据范围过滤；登录即可的接口查数据范围资源什么都看不到', async () => {
      grants.set('300', [
        {
          roleId: 'a',
          scopeOrgId: '20',
          permissions: P('audit'),
          dataScope: 'org',
        },
      ]);
      await seed('au', '10');
      await seed('sg', '20');
      expect((await as('300', '20', 'audit').expect(200)).body.data).toEqual([
        'sg',
      ]);
      expect((await as('300', '20', 'peek').expect(200)).body.data).toEqual([]);
    });
  });

  describe('权限缓存', () => {
    it('按授权版本失效：改了角色不加版本仍用缓存，加版本后下一次请求就按新配置', async () => {
      grants.set('400', [
        {
          roleId: 'r',
          scopeOrgId: null,
          permissions: P('page'),
          dataScope: 'all',
        },
      ]);
      const source = app.get(PermissionSource) as FakePermissionSource;
      await as('400', null, 'page').expect(200);
      const calls = source.calls;
      await as('400', null, 'page').expect(200);
      expect(source.calls).toBe(calls);
      grants.set('400', []);
      await as('400', null, 'page').expect(200);
      await bump();
      await as('400', null, 'page').expect(403);
    });
  });

  describe('菜单和权限码', () => {
    const menu = (user: string, org: string | null) => {
      const r = request(app.getHttpServer())
        .get('/admin/session/menu')
        .set('x-test-user', user);
      if (org) r.set('x-test-org', org);
      return r.expect(200).then((res) => res.body.data);
    };

    it('只返回有权限的页面，空目录不返回，不含按钮；权限码是明确列表', async () => {
      grants.set('500', [
        {
          roleId: 'r',
          scopeOrgId: null,
          permissions: P('page', 'update'),
          dataScope: 'all',
        },
      ]);
      const data = await menu('500', null);
      expect(data.permissions).toEqual(P('page', 'update'));
      expect(data.menus).toEqual([
        {
          id: 'p3',
          type: 'page',
          path: '/welcome',
          title: '欢迎',
          icon: null,
          rank: 0,
          component: null,
          permission: null,
          keepAlive: false,
          hidden: false,
        },
        {
          id: 'd1',
          type: 'directory',
          path: '/crm',
          title: '客户',
          icon: null,
          rank: 2,
          children: [
            {
              id: 'p1',
              type: 'page',
              path: '/crm/customer',
              title: '客户列表',
              icon: null,
              rank: 1,
              component: 'crm/customer/index',
              permission: 'test:customer:page',
              keepAlive: false,
              hidden: false,
            },
          ],
        },
      ]);
      expect(typeof data.authVersion).toBe('number');
    });

    it('超级管理员：完整的权限码列表（后端声明的和菜单上的），没有通配符', async () => {
      grants.set('600', [
        {
          roleId: 'su',
          scopeOrgId: null,
          permissions: [],
          allPermissions: true,
          dataScope: 'all',
        },
      ]);
      const data = await menu('600', null);
      expect(data.permissions).toEqual(
        expect.arrayContaining(
          P('page', 'info', 'add', 'update', 'delete', 'audit'),
        ),
      );
      expect(data.permissions).not.toContain('*');
      expect(data.menus.map((m: { id: string }) => m.id)).toEqual([
        'p3',
        'd2',
        'd1',
      ]);
    });
  });
});
