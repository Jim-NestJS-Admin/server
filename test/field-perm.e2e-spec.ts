import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IsOptional, IsString, Length } from 'class-validator';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { Column, DataSource, Entity } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  BaseController,
  BaseEntity,
  CrudController,
  CrudField,
} from '../src/core/crud/index.js';
import { AdminAuth } from '../src/core/endpoint/endpoint-auth.js';
import { FieldPerm } from '../src/core/field-perm/field-perm.decorator.js';
import {
  FieldPermSource,
  type RoleFieldRule,
} from '../src/core/field-perm/field-perm-source.js';
import {
  PermissionSource,
  type RoleGrant,
} from '../src/core/permission/permission-source.js';
import { TestAdminAuth } from './support/test-auth.js';
import { clearTestRedis, rawRedis } from './support/test-redis.js';

@Entity('demo_client')
class DemoClientEntity extends BaseEntity {
  @CrudField({ label: '名称', form: { required: true } })
  @IsString()
  @Length(1, 50)
  @Column({ type: 'varchar', length: 50 })
  name: string;

  @CrudField({ label: '手机号' })
  @FieldPerm({ label: '手机号', default: 'masked', mask: 'phone' })
  @IsOptional()
  @IsString()
  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @CrudField({ label: '成本价' })
  @FieldPerm({ label: '成本价', default: 'hidden' })
  @IsOptional()
  @IsString()
  @Column({ type: 'varchar', length: 20, nullable: true })
  cost: string | null;
}

@CrudController({
  prefix: 'test/client',
  label: '演示客户',
  entity: DemoClientEntity,
  api: ['page', 'info', 'update'],
  dataScope: true,
})
class DemoClientController extends BaseController<DemoClientEntity> {}

const P = (...a: string[]) => a.map((x) => `test:client:${x}`);
const grants = new Map<string, RoleGrant[]>();
const roleFields: RoleFieldRule[] = [];

@Injectable()
class Grants extends PermissionSource {
  async loadGrants(_t: string, u: string) {
    return structuredClone(grants.get(u) ?? []);
  }
  async loadOrgs() {
    return [];
  }
  async loadMenus() {
    return [];
  }
}

@Injectable()
class Fields extends FieldPermSource {
  async loadFieldDefaults() {
    return [];
  }
  async loadRoleFields() {
    return structuredClone(roleFields);
  }
}

describe('字段权限（T16）', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  let raw: Redis;
  const as = (
    u: string,
    org: string | null,
    path: string,
    body: object = {},
  ) => {
    const r = request(app.getHttpServer())
      .post(`/admin/test/client/${path}`)
      .set('x-test-user', u);
    if (org) r.set('x-test-org', org);
    return r.send(body);
  };
  const seed = async (name: string, org: string) => {
    await ds.query(
      "INSERT INTO demo_client (tenant_id, org_id, created_by, name, phone, cost, version) VALUES (1, ?, 9, ?, '13812345678', '99.5', 1)",
      [org, name],
    );
    const [{ id }] = await ds.query(
      'SELECT id FROM demo_client WHERE name = ?',
      [name],
    );
    return String(id);
  };
  const rows = async (u: string, org: string | null) =>
    Object.fromEntries(
      (
        (await as(u, org, 'page', { page: 1, size: 50 }).expect(200)).body.data
          .list as Record<string, unknown>[]
      ).map((r) => [r.name as string, r]),
    );

  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [AppModule, TypeOrmModule.forFeature([DemoClientEntity])],
      controllers: [DemoClientController],
    })
      .overrideProvider(AdminAuth)
      .useClass(TestAdminAuth)
      .overrideProvider(PermissionSource)
      .useClass(Grants)
      .overrideProvider(FieldPermSource)
      .useClass(Fields)
      .compile();
    app = m.createNestApplication();
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
    await ds.query('DELETE FROM demo_client');
    grants.clear();
    roleFields.length = 0;
    // 客服：看全部，字段用代码默认（手机号脱敏、成本价隐藏）
    // 经理：本部门 11，手机号和成本价可编辑
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
    roleFields.push(
      {
        roleId: 'mgr',
        resource: 'test:client',
        field: 'phone',
        state: 'editable',
      },
      {
        roleId: 'mgr',
        resource: 'test:client',
        field: 'cost',
        state: 'editable',
      },
    );
  });

  it('同一列不同行：本部门完整，其他部门按客服的状态脱敏 / 隐藏', async () => {
    await seed('mine', '11');
    await seed('other', '20');
    const r = await rows('100', '11');
    expect(r.mine).toMatchObject({ phone: '13812345678', cost: '99.5' });
    expect(r.other.phone).toBe('138****5678');
    expect(r.other).not.toHaveProperty('cost');
  });

  it('只有客服：手机号脱敏，成本价不返回', async () => {
    grants.set('200', [grants.get('100')![0]]);
    await seed('a', '11');
    const r = await rows('200', null);
    expect(r.a.phone).toBe('138****5678');
    expect(r.a).not.toHaveProperty('cost');
  });

  it('写：经理能改本部门的成本价；只读的字段提交了也不生效', async () => {
    const id = await seed('mine', '11');
    roleFields.push({
      roleId: 'mgr',
      resource: 'test:client',
      field: 'name',
      state: 'readonly',
    });
    await as('100', '11', 'update', {
      id,
      version: 1,
      data: { cost: '1', name: 'changed' },
    }).expect(200);
    const [row] = await ds.query(
      'SELECT name, cost FROM demo_client WHERE id = ?',
      [id],
    );
    expect(row).toEqual({ name: 'mine', cost: '1' });
  });

  it('页面描述带每个字段的最宽状态', async () => {
    const s = (
      await request(app.getHttpServer())
        .get('/admin/test/client/schema')
        .set('x-test-user', '100')
        .set('x-test-org', '11')
        .expect(200)
    ).body.data;
    expect(s.fieldPerms.phone.state).toBe('editable');
    expect(s.fieldPerms.cost.state).toBe('editable');
    grants.set('200', [grants.get('100')![0]]);
    const s2 = (
      await request(app.getHttpServer())
        .get('/admin/test/client/schema')
        .set('x-test-user', '200')
        .expect(200)
    ).body.data;
    expect(s2.fieldPerms).toMatchObject({
      phone: { state: 'masked', mask: 'phone' },
      cost: { state: 'hidden' },
    });
  });
});
