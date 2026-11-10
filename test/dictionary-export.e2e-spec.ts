import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Column, Entity, DataSource } from 'typeorm';
import { IsOptional, IsString } from 'class-validator';
import request from 'supertest';

import type { App } from 'supertest/types.js';
import ExcelJS from 'exceljs';
import { PermissionService } from '../src/core/permission/permission.service.js';
import { RequestContext } from '../src/core/tenant/request-context.js';
import { SystemDictType } from '../src/modules/system-log/entity/system-log.entity.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { BaseEntity } from '../src/core/crud/base.entity.js';
import { CrudController } from '../src/core/crud/crud-controller.decorator.js';
import { BaseController } from '../src/core/crud/base.controller.js';
import { CrudField } from '../src/core/crud/crud-field.decorator.js';
import { FieldPerm } from '../src/core/field-perm/field-perm.decorator.js';
import {
  PermissionSource,
  type RoleGrant,
} from '../src/core/permission/permission-source.js';
import { createTestModule } from './support/test-auth.js';
import { clearTestRedis, rawRedis } from './support/test-redis.js';
import { SharedDictionaries1794279600000 } from '../src/database/migrations/1794279600000-SharedDictionaries.js';

@Entity('test_dictionary_probe')
class DictionaryProbe extends BaseEntity {
  @CrudField({
    label: '状态',
    dictCode: 'sys.test_status',
    form: { required: true },
  })
  @IsString()
  @Column({ type: 'varchar', length: 100 })
  status: string;
  @CrudField({ label: '备注' })
  @IsOptional()
  @IsString()
  @Column({ type: 'varchar', length: 100, nullable: true })
  note: string | null;
  @CrudField({ label: '电话' })
  @FieldPerm({ default: 'masked', mask: 'phone' })
  @IsOptional()
  @IsString()
  @Column({ type: 'varchar', length: 100, nullable: true })
  phone: string | null;
  @CrudField({ label: '隐藏字段' })
  @FieldPerm({ default: 'hidden' })
  @IsOptional()
  @IsString()
  @Column({ type: 'varchar', length: 100, nullable: true })
  secret: string | null;
}
@Entity('test_dictionary_probe_item')
class DictionaryProbeItem extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true }) probeId: string;
  @CrudField({
    label: '明细状态',
    dictCode: 'sys.test_status',
    form: { required: true },
  })
  @IsString()
  @Column({ type: 'varchar', length: 100 })
  status: string;
}
@CrudController({
  prefix: 'test/dictionary-probe',
  label: '字典测试',
  entity: DictionaryProbe,
  api: ['page', 'info', 'add', 'update', 'export'],
  children: [
    {
      resource: 'lines',
      label: '明细',
      entity: DictionaryProbeItem,
      foreignKey: 'probeId',
    },
  ],
  pageQuery: { fieldEq: ['status'] },
})
class ProbeController extends BaseController<DictionaryProbe> {}
@Module({
  imports: [
    AppModule,
    TypeOrmModule.forFeature([DictionaryProbe, DictionaryProbeItem]),
  ],
  controllers: [ProbeController],
})
class ProbeModule {}
const ordinaryUsers = new Set(['200']);
@Injectable()
class DictionaryGrants extends PermissionSource {
  async loadGrants(_tenant: string, user: string): Promise<RoleGrant[]> {
    return [
      {
        roleId: 'dictionary-test',
        scopeOrgId: null,
        allPermissions: !ordinaryUsers.has(user),
        dataScope: 'all',
        permissions: [
          'system:dict-type',
          'system:dict-item',
          'test:dictionary-probe',
        ].flatMap((prefix) =>
          ['page', 'info', 'add', 'update', 'delete', 'export'].map(
            (action) => `${prefix}:${action}`,
          ),
        ),
      },
    ];
  }
  async loadOrgs() {
    return [];
  }
  async loadMenus() {
    return [];
  }
}
const binary = (
  res: request.Response,
  done: (error: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => done(null, Buffer.concat(chunks)));
  res.on('error', (error: Error) => done(error, Buffer.alloc(0)));
};

describe('T26/T27共享字典与导出', () => {
  let app: INestApplication<App>, ds: DataSource;
  beforeAll(async () => {
    const module = await createTestModule({ imports: [ProbeModule] })
      .overrideProvider(PermissionSource)
      .useClass(DictionaryGrants)
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    expect(String(ds.options.database)).toMatch(/_test$/);
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    for (const table of [
      'test_dictionary_probe_item',
      'test_dictionary_probe',
      'sys_dict_item',
      'sys_dict_type',
      'sys_idempotency',
    ])
      await ds.query(`DELETE FROM ${table}`);
    await ds.query('DELETE FROM sys_user WHERE username = ?', ['profile_dict']);
    const redis = rawRedis();
    try {
      await clearTestRedis(redis);
    } finally {
      await redis.quit();
    }
  });
  const post = (path: string, body: object, tenant = '1', user = '100') =>
    request(app.getHttpServer())
      .post('/admin/' + path)
      .set('x-test-tenant', tenant)
      .set('x-test-user', user)
      .send(body);
  const type = async (
    code = 'sys.test_status',
    builtin = true,
    tenant = '1',
    user = '100',
  ) =>
    (
      await post(
        'system/dict-type/add',
        { data: { code, name: code, builtin, enabled: true } },
        tenant,
        user,
      ).expect(200)
    ).body.data;
  const item = async (
    typeId: string,
    value = '1',
    label = '启用',
    tenant = '1',
    user = '100',
  ) =>
    (
      await post(
        'system/dict-item/add',
        { data: { typeId, value, label, enabled: true, rank: 0 } },
        tenant,
        user,
      ).expect(200)
    ).body.data;
  const options = (code: string, tenant = '1', user = '200') =>
    request(app.getHttpServer())
      .get('/admin/system/dict-type/data')
      .query({ code })
      .set('x-test-tenant', tenant)
      .set('x-test-user', user);

  it('系统字典存平台、跨租户引用同一份、普通用户不能维护或枚举系统字典', async () => {
    const dictionary = await type();
    const entry = await item(dictionary.id);
    const stored = await ds.query(
      'SELECT tenant_id, builtin FROM sys_dict_type WHERE id=?',
      [dictionary.id],
    );
    expect(String(stored[0].tenant_id)).toBe('0');
    expect(Number(stored[0].builtin)).toBe(1);
    expect(
      (await options('sys.test_status', '2').expect(200)).body.data.items,
    ).toEqual([{ value: '1', label: '启用' }]);
    await post(
      'system/dict-type/page',
      { eq: { builtin: true } },
      '1',
      '200',
    ).expect(403);
    expect(
      (await post('system/dict-type/page', {}, '1', '200').expect(200)).body
        .data.list,
    ).toEqual([]);
    await post(
      'system/dict-type/add',
      {
        data: { code: 'sys.other', name: '系统', builtin: true, enabled: true },
      },
      '1',
      '200',
    ).expect(403);
    await post(
      'system/dict-item/update',
      { id: entry.id, version: entry.version, data: { label: '越权' } },
      '2',
      '200',
    ).expect(404);
    await post('system/dict-item/update', {
      id: entry.id,
      version: entry.version,
      data: { value: '2' },
    }).expect(400);
    await post('system/dict-item/delete', { ids: [entry.id] }).expect(400);
    await post('system/dict-type/delete', { ids: [dictionary.id] }).expect(400);
  });

  it('修改共享显示名和停用会切换所有租户缓存版本；旧值不再可选', async () => {
    const dictionary = await type();
    const entry = await item(dictionary.id);
    await options('sys.test_status', '1').expect(200);
    await options('sys.test_status', '2').expect(200);
    const changed = (
      await post('system/dict-item/update', {
        id: entry.id,
        version: entry.version,
        data: { label: '新的显示名' },
      }).expect(200)
    ).body.data;
    expect(
      (await options('sys.test_status', '2').expect(200)).body.data.items[0]
        .label,
    ).toBe('新的显示名');
    await post('system/dict-item/update', {
      id: entry.id,
      version: changed.version,
      data: { enabled: false },
    }).expect(200);
    expect(
      (await options('sys.test_status', '1').expect(200)).body.data.items,
    ).toEqual([]);
    expect(
      (await options('sys.test_status', '2').expect(200)).body.data.items,
    ).toEqual([]);
  });

  it('业务字典按租户隔离，普通管理员可改值和删除；不能占用sys.前缀或更改内置标记', async () => {
    const dictionary = await type('customer.source', false, '1', '200');
    const entry = await item(dictionary.id, 'web', '网站', '1', '200');
    expect(
      (await options('customer.source', '2').expect(200)).body.data.items,
    ).toEqual([]);
    await post('system/dict-type/info', { id: dictionary.id }, '2').expect(404);
    await post(
      'system/dict-item/update',
      { id: entry.id, version: entry.version, data: { value: 'store' } },
      '1',
      '200',
    ).expect(200);
    expect(
      (await options('customer.source').expect(200)).body.data.items[0].value,
    ).toBe('store');
    await post(
      'system/dict-type/update',
      { id: dictionary.id, version: 1, data: { builtin: true } },
      '1',
      '200',
    ).expect(409);
    const latest = (
      await post(
        'system/dict-type/info',
        { id: dictionary.id },
        '1',
        '200',
      ).expect(200)
    ).body.data;
    await post(
      'system/dict-type/update',
      { id: dictionary.id, version: latest.version, data: { builtin: true } },
      '1',
      '200',
    ).expect(400);
    await post(
      'system/dict-type/add',
      {
        data: { code: 'sys.fake', name: '伪造', builtin: false, enabled: true },
      },
      '1',
      '200',
    ).expect(400);
    await post(
      'system/dict-item/delete',
      { ids: [entry.id] },
      '1',
      '200',
    ).expect(200);
    await post(
      'system/dict-type/delete',
      { ids: [dictionary.id] },
      '1',
      '200',
    ).expect(200);
  });

  it('dictCode返回启用项，保存拒绝不存在及停用值，已停用值不能重新提交', async () => {
    const dictionary = await type();
    const entry = await item(dictionary.id);
    const schema = (
      await request(app.getHttpServer())
        .get('/admin/test/dictionary-probe/schema')
        .set('x-test-user', '200')
        .expect(200)
    ).body.data;
    expect(schema.dictionaries.status).toEqual([{ value: '1', label: '启用' }]);
    expect(
      schema.form.find((field: { field: string }) => field.field === 'status')
        .component,
    ).toBe('select');
    await post('test/dictionary-probe/add', {
      data: { status: 'missing' },
    }).expect(400);
    const row = (
      await post('test/dictionary-probe/add', { data: { status: '1' } }).expect(
        200,
      )
    ).body.data;
    await post('system/dict-item/update', {
      id: entry.id,
      version: entry.version,
      data: { enabled: false },
    }).expect(200);
    await post('test/dictionary-probe/update', {
      id: row.id,
      version: row.version,
      data: { status: '1' },
    }).expect(400);
  });

  it('主子表字典校验失败定位到新增行并回滚整个聚合', async () => {
    const dictionary = await type();
    await item(dictionary.id);
    const response = await post('test/dictionary-probe/add', {
      data: { status: '1' },
      children: {
        lines: { added: [{ clientId: 'line-a', status: 'missing' }] },
      },
    }).expect(400);
    expect(response.body.data.errors[0]).toMatchObject({
      resource: 'lines',
      clientId: 'line-a',
      field: 'status',
    });
    expect(
      Number(
        (await ds.query('SELECT COUNT(*) AS n FROM test_dictionary_probe'))[0]
          .n,
      ),
    ).toBe(0);
  });

  it('Excel与CSV共享可见列顺序和逐行脱敏，公式只写为文字，格式入参受校验', async () => {
    const dictionary = await type();
    await item(dictionary.id);
    await post('test/dictionary-probe/add', {
      data: {
        status: '1',
        note: '=HYPERLINK("bad")',
        phone: '13812345678',
        secret: '机密',
      },
    }).expect(200);
    const columns = ['note', 'phone', 'secret'];
    const csv = await post(
      'test/dictionary-probe/export',
      { format: 'csv', columns },
      '1',
      '200',
    )
      .buffer(true)
      .parse(binary)
      .expect(200);
    const text = (csv.body as Buffer).toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('138****5678');
    expect(text).not.toContain('机密');
    expect(text).not.toContain('隐藏字段');
    expect(text).toContain("'=HYPERLINK");
    const xlsx = await post(
      'test/dictionary-probe/export',
      { format: 'xlsx', columns },
      '1',
      '200',
    )
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      xlsx.body as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sheet = workbook.worksheets[0];
    expect(sheet.rowCount).toBe(2);
    expect(sheet.getRow(1).values).toEqual([undefined, '备注', '电话']);
    expect(sheet.getCell('A2').value).toBe('\'=HYPERLINK("bad")');
    expect(sheet.getCell('B2').value).toBe('138****5678');
    await post(
      'test/dictionary-probe/export',
      { format: 'pdf' },
      '1',
      '200',
    ).expect(400);
    await post(
      'test/dictionary-probe/export',
      { columns: ['passwordHash'] },
      '1',
      '200',
    ).expect(400);
  });

  it('导出跨500行分页且不受当前页影响，Excel保留数值型版本列', async () => {
    const dictionary = await type();
    await item(dictionary.id);
    await app.get(RequestContext).run({ tenantId: '1' }, () =>
      ds.getRepository(DictionaryProbe).insert(
        Array.from({ length: 501 }, (_, index) => ({
          status: '1',
          note: String(index),
        })),
      ),
    );
    const response = await post(
      'test/dictionary-probe/export',
      { format: 'xlsx', columns: ['note', 'version'], page: 2, size: 1 },
      '1',
      '200',
    )
      .buffer(true)
      .parse(binary)
      .expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      response.body as Parameters<typeof workbook.xlsx.load>[0],
    );
    expect(workbook.worksheets[0].rowCount).toBe(502);
    expect(workbook.worksheets[0].getCell('B2').value).toBe(1);
  });

  it('会话资料返回由权限来源确认的superAdmin，不信任客户端标记', async () => {
    const created = (
      await post('system/user/create', {
        username: 'profile_dict',
        nickname: '字典用户',
        password: 'StrongPassword8',
      }).expect(200)
    ).body.data;
    const profileRequest = () =>
      request(app.getHttpServer())
        .get('/admin/session/profile')
        .set('x-test-user', created.id);
    expect((await profileRequest().expect(200)).body.data.superAdmin).toBe(
      true,
    );
    ordinaryUsers.add(created.id);
    await app
      .get(RequestContext)
      .run({ tenantId: '1' }, () =>
        app.get(PermissionService).bumpVersion('1'),
      );
    try {
      const ordinary = await request(app.getHttpServer())
        .get('/admin/session/profile')
        .set('x-test-user', created.id)
        .expect(200);
      expect(ordinary.body.data.superAdmin).toBe(false);
    } finally {
      ordinaryUsers.delete(created.id);
      await app
        .get(RequestContext)
        .run({ tenantId: '1' }, () =>
          app.get(PermissionService).bumpVersion('1'),
        );
    }
  });

  it('历史业务字典占用sys.前缀时迁移停止，不悄悄隐藏或覆盖数据', async () => {
    await app.get(RequestContext).run({ tenantId: '1' }, () =>
      ds.getRepository(SystemDictType).insert({
        code: 'sys.legacy',
        name: '旧业务字典',
        builtin: false,
        enabled: true,
      }),
    );
    const runner = ds.createQueryRunner();
    await runner.connect();
    try {
      await expect(
        new SharedDictionaries1794279600000().up(runner),
      ).rejects.toThrow('保留前缀');
    } finally {
      await runner.release();
    }
    const rows = await ds.query(
      "SELECT code FROM sys_dict_type WHERE tenant_id=1 AND code='sys.legacy'",
    );
    expect(rows).toHaveLength(1);
  });

  it('基础字典迁移保留编号和项目关联并迁到平台', async () => {
    const dictionary = await type('common_status', false);
    const entry = await item(dictionary.id);
    const runner = ds.createQueryRunner();
    await runner.connect();
    try {
      // 真实模拟升级前的T08表结构，验证新增列的DDL和保留数据迁移。
      await runner.dropColumn('sys_dict_type', 'rank');
      await runner.dropColumn('sys_dict_type', 'builtin');
      const migration = new SharedDictionaries1794279600000();
      await migration.up(runner);
      await migration.down(runner);
      expect(
        (
          await runner.query('SELECT code FROM sys_dict_type WHERE id=?', [
            dictionary.id,
          ])
        )[0].code,
      ).toBe('common_status');
      await migration.up(runner);
    } finally {
      await runner.release();
    }
    const row = (
      await post('system/dict-type/page', { eq: { builtin: true } }).expect(200)
    ).body.data.list[0];
    expect(row.id).toBe(dictionary.id);
    expect(row.code).toBe('sys.common_status');
    expect(
      (await options('sys.common_status', '2').expect(200)).body.data.items,
    ).toEqual([{ value: '1', label: '启用' }]);
    const actual = await ds.query(
      'SELECT tenant_id FROM sys_dict_item WHERE id=?',
      [entry.id],
    );
    expect(String(actual[0].tenant_id)).toBe('0');
  });
});
