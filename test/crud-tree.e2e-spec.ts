import type { INestApplication } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IsInt, IsOptional, IsString, Length, Matches } from 'class-validator';
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
import { resolveCrudMeta } from '../src/core/crud/crud-meta.js';
import { createTestModule } from './support/test-auth.js';

@Entity('demo_category')
class DemoCategoryEntity extends BaseEntity {
  @CrudField({ label: '名称', form: { required: true } })
  @IsString()
  @Length(1, 50)
  @Column({ type: 'varchar', length: 50 })
  name: string;

  @CrudField({ label: '上级', list: false, nullable: true })
  @IsOptional()
  @Matches(/^[1-9]\d{0,19}$/)
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  parentId: string | null;

  @CrudField({ label: '排序' })
  @IsOptional()
  @IsInt()
  @Column({ type: 'int', default: 0 })
  sort: number;
}

@CrudController({
  prefix: 'test/category',
  label: '演示分类',
  entity: DemoCategoryEntity,
  api: ['info', 'add', 'update', 'delete', 'recycle', 'restore', 'tree'],
  tree: { nameField: 'name', sortField: 'sort' },
})
class DemoCategoryController extends BaseController<DemoCategoryEntity> {}

/** 架构「通用 CRUD · 树形资源」：树形列表、父节点校验（不成环）、有下级不能删、恢复要求上级有效 */
describe('树形资源', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  const call = (path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(`/admin/test/category/${path}`)
      .send(body);
  const add = async (name: string, parentId: string | null, sort = 0) =>
    (await call('add', { data: { name, parentId, sort } }).expect(200)).body
      .data as { id: string; version: number };
  const version = async (id: string) =>
    (
      (await ds.query('SELECT version FROM demo_category WHERE id = ?', [
        id,
      ])) as { version: number }[]
    )[0].version;

  beforeAll(async () => {
    const moduleRef = await createTestModule({
      imports: [AppModule, TypeOrmModule.forFeature([DemoCategoryEntity])],
      controllers: [DemoCategoryController],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM demo_category');
  });

  it('启动检查：开放 tree 接口必须配置 tree；父级字段必须可写', () => {
    expect(() =>
      resolveCrudMeta({
        prefix: 'test/x',
        label: 'x',
        entity: DemoCategoryEntity,
        api: ['tree'],
      }),
    ).toThrow(/tree/);
    expect(() =>
      resolveCrudMeta({
        prefix: 'test/x',
        label: 'x',
        entity: DemoCategoryEntity,
        api: ['tree'],
        tree: { parentField: 'createdBy', nameField: 'name' },
      }),
    ).toThrow(/父级字段/);
  });

  it('树形列表平铺返回，同级按排序字段；页面描述带 tree，父级字段默认树形选择', async () => {
    const root = await add('根', null);
    await add('乙', root.id, 2);
    await add('甲', root.id, 1);
    const list = (await call('tree').expect(200)).body.data.list as {
      name: string;
      parentId: string | null;
    }[];
    expect(list.map((r) => r.name)).toEqual(['根', '甲', '乙']);
    expect(list[1].parentId).toBe(root.id);

    const schema = (
      await request(app.getHttpServer())
        .get('/admin/test/category/schema')
        .expect(200)
    ).body.data;
    expect(schema.tree).toEqual({
      parentField: 'parentId',
      nameField: 'name',
      sortField: 'sort',
    });
    expect(
      schema.form.find((f: { field: string }) => f.field === 'parentId')
        .component,
    ).toBe('tree-select');
  });

  it('父节点不存在、是自己、是自己的下级：400，数据不变', async () => {
    await call('add', { data: { name: 'x', parentId: '999999' } }).expect(400);
    const a = await add('A', null);
    const b = await add('B', a.id);
    const c = await add('C', b.id);
    await call('update', {
      id: a.id,
      version: a.version,
      data: { parentId: a.id },
    }).expect(400);
    const res = await call('update', {
      id: a.id,
      version: a.version,
      data: { parentId: c.id },
    }).expect(400);
    expect(JSON.stringify(res.body)).toContain('下级');
    // 移动到别的分支可以；移回根节点可以
    const d = await add('D', null);
    await call('update', {
      id: c.id,
      version: c.version,
      data: { parentId: d.id },
    }).expect(200);
    await call('update', {
      id: c.id,
      version: await version(c.id),
      data: { parentId: null },
    }).expect(200);
  });

  it('有下级的节点不能删除；连同下级一起删可以', async () => {
    const a = await add('A', null);
    const b = await add('B', a.id);
    await call('delete', { ids: [a.id] }).expect(400);
    await call('delete', { ids: [a.id, b.id] }).expect(200);
  });

  it('恢复时上级已删除：400；连同上级一起恢复可以', async () => {
    const a = await add('A', null);
    const b = await add('B', a.id);
    await call('delete', { ids: [a.id, b.id] }).expect(200);
    await call('restore', {
      items: [{ id: b.id, version: await version(b.id) }],
    }).expect(400);
    await call('restore', {
      items: [
        { id: a.id, version: await version(a.id) },
        { id: b.id, version: await version(b.id) },
      ],
    }).expect(200);
  });
});
