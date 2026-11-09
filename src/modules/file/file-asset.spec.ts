import {
  DataSource,
  type EntityManager,
  type QueryRunner,
  type Table,
} from 'typeorm';
import { ClsServiceManager } from 'nestjs-cls';
import { Reflector } from '@nestjs/core';
import { resolveCrudMeta } from '../../core/crud/crud-meta.js';
import {
  CrudContextProvider,
  TenantOnlyScope,
} from '../../core/crud/crud-scope.js';
import { SnakeNamingStrategy } from '../../core/database/naming.strategy.js';
import { RequestContext } from '../../core/tenant/request-context.js';
import { AuthzContext } from '../../core/permission/authz-context.js';
import { IdempotencyLedger } from '../../core/security/idempotency.ledger.js';
import { ScopedSelectQueryBuilder } from '../../core/tenant/scoped-query-builder.js';
import { CreateFileAsset1793923200000 } from '../../database/migrations/1793923200000-CreateFileAsset.js';
import { FileAssetEntity } from './entity/file-asset.entity.js';
import { FileAssetService } from './service/file-asset.service.js';
import { FileAssetController } from './controller/admin/file-asset.controller.js';
import { FileGuard } from './file.guard.js';
import { DenyFileAccess } from './file.ports.js';

const key = (tenant: string) =>
  `tenants/${tenant}/12c873aa-f252-4e01-8d36-0123456789ab.png`;
const file = (tenant = '1') => ({
  key: key(tenant),
  mime: 'image/png',
  bytes: 50,
  sha256: 'a'.repeat(64),
});
const context = new RequestContext(ClsServiceManager.getClsService());
let ds: DataSource;
let service: FileAssetService;
const meta = resolveCrudMeta({
  prefix: 'file/asset',
  label: '文件',
  entity: FileAssetEntity,
  api: ['page', 'info'],
  service: FileAssetService,
});

beforeAll(async () => {
  ds = new DataSource({
    type: 'mysql',
    database: 'metadata_only_no_connection',
    entities: [FileAssetEntity],
    namingStrategy: new SnakeNamingStrategy(),
  });
  await (ds as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  // 只构建列/索引元数据，永远不 initialize、不建立连接。
  Object.defineProperty(ds, 'isInitialized', { value: true, writable: true });
  service = new FileAssetService();
  service.bindCrud({
    dataSource: ds,
    context: new CrudContextProvider(context),
    scope: new TenantOnlyScope(),
    meta,
    childOwner: () => undefined,
    audit: { beforeHardDelete: async () => {} } as never,
    authz: new AuthzContext(ClsServiceManager.getClsService()),
    idempotency: new IdempotencyLedger(ClsServiceManager.getClsService(), ds),
  });
});
afterEach(() => vi.restoreAllMocks());

it('页面描述只读，SQL默认不选对象名/摘要，响应白名单不含内部数据', () => {
  expect(meta.api).toEqual(['page', 'info']);
  expect(meta.addable).toEqual([]);
  expect(meta.updatable).toEqual([]);
  expect(meta.readable).toEqual(
    expect.arrayContaining(['name', 'mime', 'bytes']),
  );
  expect(meta.readable).not.toEqual(expect.arrayContaining(['objectKey']));
  expect(meta.readable).not.toEqual(expect.arrayContaining(['sha256']));
  const sql = ds.createQueryBuilder(FileAssetEntity, 'e').getSql();
  expect(sql.slice(0, sql.indexOf(' FROM '))).not.toMatch(/object_key|sha256/);
});

it('没有请求上下文时拒绝，不落入默认租户', async () => {
  await expect(service.ready()).rejects.toThrow(/没有租户上下文/);
});

it('新增的只读元数据控制器也默认拒绝，守卫在执行查询前生效', async () => {
  const guard = new FileGuard(new DenyFileAccess(), new Reflector());
  await expect(
    guard.canActivate({
      getClass: () => FileAssetController,
      getHandler: () => function page() {},
    } as never),
  ).rejects.toMatchObject({ code: 4001 });
});

it('插入只取模块白名单，身份审计字段由实际 insertRow 填入', async () => {
  let inserted: Record<string, unknown> | undefined;
  const builder = {
    insert: () => builder,
    into: () => builder,
    values: (value: Record<string, unknown>) => {
      inserted = value;
      return builder;
    },
    execute: async () => ({ identifiers: [{ id: '9007199254740993' }] }),
  };
  const writer = {
    createQueryBuilder: () => builder,
  } as unknown as EntityManager;
  const transaction = (async (fn: (m: EntityManager) => Promise<unknown>) =>
    fn(writer)) as DataSource['transaction'];
  vi.spyOn(ds, 'transaction').mockImplementation(transaction);
  const recorded = vi.spyOn(IdempotencyLedger.prototype, 'recordInTx');
  await context.run({ tenantId: '2', userId: '7', orgId: '3' }, async () => {
    const result = await service.insert({
      ...file('2'),
      tenantId: '99',
      createdBy: '99',
      orgId: '99',
      id: '99',
      version: 99,
    } as never);
    expect(result.id).toBe('9007199254740993');
    expect(inserted).toEqual({
      name: key('2').split('/').at(-1),
      objectKey: key('2'),
      mime: 'image/png',
      bytes: 50,
      sha256: 'a'.repeat(64),
      tenantId: '2',
      orgId: '3',
      createdBy: '7',
      updatedBy: '7',
    });
    expect(recorded).toHaveBeenCalledWith(writer, {
      id: '9007199254740993',
      name: key('2').split('/').at(-1),
      mime: 'image/png',
      bytes: 50,
    });
  });
});

it('外租户对象名和非法元数据均在开启事务前拒绝', async () => {
  const tx = vi.spyOn(ds, 'transaction');
  await context.run({ tenantId: '1', userId: '7' }, async () => {
    await expect(service.insert(file('2'))).rejects.toMatchObject({
      code: 4003,
    });
    await expect(
      service.insert({ ...file(), sha256: 'invalid' }),
    ).rejects.toMatchObject({ code: 4000 });
    await expect(service.insert({ ...file(), bytes: 0 })).rejects.toMatchObject(
      { code: 4000 },
    );
  });
  expect(tx).not.toHaveBeenCalled();
});

it('按编号查询复用真实范围构造器，附加内部列但不移除租户或软删除条件', async () => {
  const captured: { sql: string; params: unknown[] }[] = [];
  vi.spyOn(ScopedSelectQueryBuilder.prototype, 'getOne').mockImplementation(
    async function (this: ScopedSelectQueryBuilder<FileAssetEntity>) {
      const [sql, params] = this.getQueryAndParameters();
      captured.push({ sql, params });
      return null;
    },
  );
  for (const tenantId of ['1', '2'])
    await context.run({ tenantId, userId: '7' }, async () =>
      expect(await service.find('9007199254740993')).toBeNull(),
    );
  for (const [i, query] of captured.entries()) {
    expect(query.sql).toMatch(/object_key/);
    expect(query.sql).toMatch(/sha256/);
    expect(query.sql).toMatch(/deleted_at.*IS NULL/);
    expect(query.sql).toMatch(/AND.*tenant_id/);
    expect(query.params).toEqual(['9007199254740993', String(i + 1)]);
  }
});

it('迁移列与实体一致，并包含软删除生成列和租户索引；不执行DDL', async () => {
  let table: Table | undefined;
  const runner = {
    createTable: async (value: Table) => {
      table = value;
    },
  } as unknown as QueryRunner;
  await new CreateFileAsset1793923200000().up(runner);
  const entity = ds.getMetadata(FileAssetEntity);
  expect(table!.columns.map((c) => c.name).sort()).toEqual(
    entity.columns.map((c) => c.databaseName).sort(),
  );
  expect(table!.columns.find((c) => c.name === 'active_guard')).toMatchObject({
    generatedType: 'STORED',
    asExpression: 'IF(`deleted_at` IS NULL, 1, NULL)',
  });
  expect(
    table!.indices
      .map((i) => ({ name: i.name ?? '', columns: i.columnNames }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ).toEqual(
    entity.indices
      .map((i) => ({
        name: i.name,
        columns: i.columns.map((c) => c.databaseName),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
});
