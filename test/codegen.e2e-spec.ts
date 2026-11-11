/* eslint-disable typescript/no-misused-spread -- 规格和 DTO 在这些测试中均为 JSON 字面量，不含类实例方法。 */
import {
  Injectable,
  Module,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import {
  PermissionSource,
  type RoleGrant,
} from '../src/core/permission/permission-source.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, type MigrationInterface } from 'typeorm';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AppConfigService } from '../src/core/config/app-config.service.js';
import { RequestContext } from '../src/core/tenant/request-context.js';
import { CodegenModule } from '../src/modules/codegen/codegen.module.js';
import { CodegenService } from '../src/modules/codegen/codegen.service.js';
import { CodegenEntity } from '../src/modules/codegen/codegen.entity.js';
import { CodegenModuleSpec1794312000000 } from '../src/database/migrations/1794312000000-CodegenModuleSpec.js';
import {
  migrateLegacyConfig,
  specToConfig,
  type ModuleSpec,
} from '../src/modules/codegen/module-spec.js';
import { SystemDictionaryService } from '../src/modules/system-log/service/system-dictionary.service.js';
import { LocalCodegenTools } from '../src/modules/codegen/local-tools.js';
import { runCodegen } from '../src/scripts/codegen.js';
import { callCodegenTool } from '../src/scripts/codegen-mcp.js';
import { loadGenerated } from './support/generated-code.js';
import { createTestModule } from './support/test-auth.js';
import { TenantRepositoryFactory } from '../src/core/tenant/tenant-repository.js';
import { clearTestRedis, rawRedis } from './support/test-redis.js';
import { renderServer } from '../src/modules/codegen/render-server.js';

@Module({ imports: [AppModule, CodegenModule] })
class GeneratorTestModule {}

const newSpec = (businessName: string): ModuleSpec => ({
  version: 1,
  moduleName: 'cgprobe',
  businessName,
  title: '生成验收',
  permissionPrefix: `cgprobe:${businessName}`,
  tableName: `cgprobe_${businessName}`,
  template: 'single',
  fields: [
    {
      property: 'name',
      column: 'name',
      label: '名称',
      type: 'string',
      length: 80,
    },
  ],
});

describe('T28 规格到代码完整链路', () => {
  let app: INestApplication,
    ds: DataSource,
    root: string,
    serverRoot: string,
    adminRoot: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'jna-codegen-e2e-'));
    serverRoot = join(root, 'server');
    adminRoot = join(root, 'admin');
    await mkdir(serverRoot, { recursive: true });
    await mkdir(join(adminRoot, 'codegen-templates'), { recursive: true });
    for (const projectRoot of [serverRoot, adminRoot]) {
      await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}');
      await symlink(
        join(process.cwd(), 'node_modules'),
        join(projectRoot, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    await writeFile(
      join(serverRoot, '.prettierrc'),
      await readFile(join(process.cwd(), '.prettierrc')),
    );
    await writeFile(
      join(adminRoot, '.prettierrc.js'),
      await readFile(join(process.cwd(), '../admin/.prettierrc.js')),
    );
    for (const file of ['page.vue.tpl'])
      await writeFile(
        join(adminRoot, 'codegen-templates', file),
        await readFile(join(process.cwd(), '../admin/codegen-templates', file)),
      );
    const module = await createTestModule({
      imports: [GeneratorTestModule],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    expect(String(ds.options.database)).toMatch(/_test$/);
    const config = app.get(ConfigService);
    config.set('CODEGEN_SERVER_ROOT', serverRoot);
    config.set('CODEGEN_ADMIN_ROOT', adminRoot);
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    await ds.query('DELETE FROM sys_codegen');
    await ds.query('DELETE FROM sys_idempotency');
    const redis = rawRedis();
    try {
      await clearTestRedis(redis);
    } finally {
      await redis.quit();
    }
  });
  const post = (path: string, body: object, tenant = '1') =>
    request(app.getHttpServer())
      .post(`/admin/dev/codegen/${path}`)
      .set('x-test-tenant', tenant)
      .send(body);

  it('HTTP 返回精确错误路径，严格拒绝显示项和未知版本；目录类型由后端返回', async () => {
    const result = await post('validate-spec', {
      spec: { ...newSpec('invalid'), version: 99, listed: true },
    }).expect(200);
    expect(
      result.body.data.errors.map((e: { path: string }) => e.path),
    ).toEqual(expect.arrayContaining(['version', 'listed']));
    const rejected = await post('preview-spec', {
      spec: { ...newSpec('invalid'), fields: [null] },
    }).expect(400);
    expect(rejected.body.data.errors[0].field).toBe('fields[0]');
    const types = await post('field-types', {}).expect(200);
    expect(
      types.body.data.find((t: { type: string }) => t.type === 'money'),
    ).toMatchObject({ databaseType: 'decimal', scale: 2 });
  });

  it('新建或重命名重复规格返回400并定位businessName，跨租户不误判', async () => {
    const spec = newSpec('duplicate');
    const saved = (await post('save-spec', { spec }).expect(200)).body.data;
    const duplicate = await post('save-spec', { spec }).expect(400);
    expect(duplicate.body.data.errors).toEqual([
      {
        field: 'businessName',
        messages: ['模块 cgprobe.duplicate 已有生成记录'],
      },
    ]);
    const another = (
      await post('save-spec', { spec: newSpec('another') }).expect(200)
    ).body.data;
    const info = (await post('info', { id: another.id }).expect(200)).body.data;
    await post('save-spec', {
      id: another.id,
      version: info.version,
      spec,
    }).expect(400);
    await post('save-spec', { spec }, '2').expect(200);
    const same = (await post('info', { id: saved.id }).expect(200)).body.data;
    await post('save-spec', {
      id: saved.id,
      version: same.version,
      spec,
    }).expect(200);
  });

  it('写入后经MySQL JSON重排仍为已生成，嵌套权限和树配置按稳定序列化比较', async () => {
    const spec = newSpec('stable');
    spec.template = 'tree';
    spec.tree = {
      sortField: 'sort',
      parentField: 'parentId',
      nameField: 'name',
    };
    spec.fields[0].fieldPerm = { default: 'masked', mask: 'all' };
    spec.fields.push(
      {
        property: 'parentId',
        column: 'parent_id',
        label: '上级',
        type: 'reference',
        nullable: true,
      },
      { property: 'sort', column: 'sort', label: '排序', type: 'int' },
    );
    const preview = (await post('preview-spec', { spec }).expect(200)).body
      .data;
    expect(
      preview.files.some((file: { path: string }) =>
        file.path.startsWith('src/locales/'),
      ),
    ).toBe(false);
    const result = (
      await post('write-spec', {
        spec,
        fingerprint: preview.fingerprint,
      }).expect(200)
    ).body.data;
    expect(result.failed).toEqual([]);
    const record = (await post('list', {}).expect(200)).body.data.find(
      (row: { name: string }) => row.name === 'cgprobe.stable',
    );
    expect(record.status).toBe('generated');
    const reordered = structuredClone(spec);
    reordered.fields[0].fieldPerm = { mask: 'all', default: 'masked' };
    reordered.tree = {
      nameField: 'name',
      sortField: 'sort',
      parentField: 'parentId',
    };
    await post('save-spec', {
      id: record.id,
      version: record.version,
      spec: reordered,
    }).expect(200);
    expect(
      (await post('list', {}).expect(200)).body.data.find(
        (row: { id: string }) => row.id === record.id,
      ).status,
    ).toBe('generated');
    const tables = (await post('tables', {}).expect(200)).body.data.map(
      (row: { table: string }) => row.table,
    );
    expect(
      tables.filter((table: string) =>
        ['migrations', 'typeorm_metadata', 'file_asset'].includes(table),
      ),
    ).toEqual([]);
    for (const table of ['migrations', 'typeorm_metadata', 'file_asset'])
      await post('import-spec', { tables: [table] }).expect(400);
  });

  it('损坏的旧配置只影响自身，可正常列出、导入其他表并删除坏记录', async () => {
    const context = app.get(RequestContext);
    const invalid = await context.run({ tenantId: '1' }, () =>
      app
        .get(TenantRepositoryFactory)
        .for(CodegenEntity)
        .insert({
          name: 'invalid.record',
          label: '坏配置',
          config: { obsolete: true },
        }),
    );
    await post('save-spec', { spec: newSpec('validrecord') }).expect(200);
    const list = (await post('list', {}).expect(200)).body.data;
    expect(list).toHaveLength(2);
    expect(list.find((r: { id: string }) => r.id === invalid)).toMatchObject({
      status: 'invalid',
      error: expect.any(String),
    });
    expect(
      list.find((r: { name: string }) => r.name === 'cgprobe.validrecord'),
    ).toMatchObject({ status: 'notGenerated', spec: { version: 1 } });
    await post('tables', {}).expect(200);
    await post('info', { id: invalid }).expect(400);
    await post('delete', { id: invalid }).expect(200);
    expect((await post('list', {}).expect(200)).body.data).toHaveLength(1);
  });

  it('显式覆盖只允许预览中的文件；CLI/MCP 共用覆盖确认和指纹保护', async () => {
    const spec = newSpec('overwrite');
    const first = (await post('preview-spec', { spec }).expect(200)).body.data;
    const file = first.files.find((f: { path: string }) =>
      f.path.endsWith('.entity.ts'),
    );
    const path = join(serverRoot, file.path);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '// 人工修改');
    let preview = (await post('preview-spec', { spec }).expect(200)).body.data;
    expect(
      preview.files.find((f: { key: string }) => f.key === file.key).diff,
    ).toContain('@@');
    await post('write-spec', {
      spec,
      fingerprint: preview.fingerprint,
      overwrite: ['server:src/core/forbidden.ts'],
    }).expect(400);
    const result = (
      await post('write-spec', {
        spec,
        fingerprint: preview.fingerprint,
        overwrite: [file.key],
      }).expect(200)
    ).body.data;
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(file.content);
    await writeFile(path, '// 新的人工修改');
    preview = (await post('preview-spec', { spec }).expect(200)).body.data;
    const config = app.get(AppConfigService);
    const spy = vi
      .spyOn(config, 'codegen', 'get')
      .mockReturnValue({ enabled: true, serverRoot, adminRoot, tenantId: '1' });
    try {
      const tools = new LocalCodegenTools(
        app.get(CodegenService),
        config,
        app.get(RequestContext),
        app.get(SystemDictionaryService),
      );
      const specFile = join(root, 'overwrite-spec.json');
      await writeFile(specFile, JSON.stringify(spec));
      const written = (await runCodegen(
        [
          specFile,
          '--write',
          '--confirm',
          preview.fingerprint,
          '--overwrite',
          file.key,
        ],
        tools,
      )) as { failed: unknown[]; skipped: string[] };
      expect(written.failed).toEqual([]);
      expect(written.skipped).toEqual([]);
      await writeFile(path, '// MCP人工修改');
      preview = (await post('preview-spec', { spec }).expect(200)).body.data;
      const mcp = await callCodegenTool(tools, 'write_spec', {
        spec,
        fingerprint: preview.fingerprint,
        overwrite: [file.key],
      });
      expect(mcp.isError).toBeUndefined();
      expect(await readFile(path, 'utf8')).toBe(file.content);
      await expect(
        runCodegen([specFile, '--check', '--overwrite', file.key], tools),
      ).rejects.toThrow('用法');
    } finally {
      spy.mockRestore();
    }
  });

  it('已有表只生成增量 ALTER，保留原数据，回退不删原表；结构变化令旧指纹失效', async () => {
    const hasTenantColumn = async () => {
      const runner = ds.createQueryRunner();
      try {
        return await runner.hasColumn('cgimport_customer', 'tenant_id');
      } finally {
        await runner.release();
      }
    };
    await ds.query('DROP TABLE IF EXISTS cgimport_customer');
    await ds.query(
      "CREATE TABLE cgimport_customer (id bigint unsigned PRIMARY KEY AUTO_INCREMENT, code varchar(40) NOT NULL UNIQUE COMMENT '编码')",
    );
    await ds.query(
      "INSERT INTO cgimport_customer (code) VALUES ('existing-customer')",
    );
    const spec = (
      await post('import-spec', { tables: ['cgimport_customer'] }).expect(200)
    ).body.data.spec as ModuleSpec;
    spec.fields[0].defaultValue = 'new-customer';
    spec.fields[0].comment = "编码'); DROP TABLE cgimport_customer; --";
    spec.fields.push({
      property: 'note',
      column: 'note',
      label: '备注',
      type: 'string',
      length: 30,
      nullable: true,
      defaultValue: null,
    });
    let preview = (await post('preview-spec', { spec }).expect(200)).body.data;
    expect(preview.sql.join('\n')).toContain('ALTER TABLE');
    expect(preview.sql.join('\n')).not.toContain('CREATE TABLE');
    expect(await hasTenantColumn()).toBe(false);
    const invalid = structuredClone(spec);
    invalid.fields[0].length = 41;
    await post('preview-spec', { spec: invalid }).expect(400);
    await ds.query('ALTER TABLE cgimport_customer ADD extra varchar(20) NULL');
    await post('write-spec', { spec, fingerprint: preview.fingerprint }).expect(
      409,
    );
    preview = (await post('preview-spec', { spec }).expect(200)).body.data;
    const result = (
      await post('write-spec', {
        spec,
        fingerprint: preview.fingerprint,
      }).expect(200)
    ).body.data;
    expect(result.failed).toEqual([]);
    expect(await hasTenantColumn()).toBe(false);
    const migrationFiles = await Promise.all(
      preview.files
        .filter((f: { path: string }) => f.path.includes('/migrations/'))
        .map(async (f: { path: string }) => ({
          project: 'server' as const,
          path: f.path,
          content: await readFile(join(serverRoot, f.path), 'utf8'),
        })),
    );
    expect(migrationFiles).toHaveLength(1);
    expect(migrationFiles[0].path).toContain('-UpdateCgimportCustomer-');
    expect(migrationFiles[0].content).not.toContain('dropTable');
    const loaded = loadGenerated(migrationFiles);
    const Migration = Object.values(
      [...loaded.values()][0],
    )[0] as new () => MigrationInterface;
    const runner = ds.createQueryRunner();
    await runner.connect();
    try {
      await new Migration().up(runner);
      expect(await runner.hasColumn('cgimport_customer', 'tenant_id')).toBe(
        true,
      );
      expect(
        (await ds.query('SELECT code, extra FROM cgimport_customer'))[0],
      ).toEqual({ code: 'existing-customer', extra: null });
      await ds.query('INSERT INTO cgimport_customer () VALUES ()');
      expect(
        (
          await ds.query(
            "SELECT COUNT(*) AS n FROM cgimport_customer WHERE code='new-customer'",
          )
        )[0].n,
      ).toBe('1');
      const settled = (await post('preview-spec', { spec }).expect(200)).body
        .data;
      expect(
        settled.files.some((f: { path: string }) =>
          f.path.includes('/migrations/'),
        ),
      ).toBe(false);
      await new Migration().down(runner);
      expect(await runner.hasTable('cgimport_customer')).toBe(true);
      expect(await runner.hasColumn('cgimport_customer', 'tenant_id')).toBe(
        false,
      );
      expect(
        (await ds.query('SELECT code FROM cgimport_customer'))[0].code,
      ).toBe('existing-customer');
    } finally {
      await runner.release();
    }
  });

  it('旧配置迁移可重复执行；旧接口能读取和保存规格，新配置仍按租户隔离', async () => {
    const spec = newSpec('legacy');
    const legacy = specToConfig(spec);
    legacy.fields[0].list = false;
    const ctx = app.get(RequestContext);
    const id = await ctx.run({ tenantId: '1' }, () =>
      app
        .get(TenantRepositoryFactory)
        .for(CodegenEntity)
        .insert({ name: 'cgprobe.legacy', label: '旧配置', config: legacy }),
    );
    const runner = ds.createQueryRunner();
    await runner.connect();
    try {
      const migration = new CodegenModuleSpec1794312000000();
      await migration.up(runner);
      await migration.up(runner);
    } finally {
      await runner.release();
    }
    const info = (await post('info', { id }).expect(200)).body.data;
    expect(info.spec).toEqual(migrateLegacyConfig(legacy));
    expect(info.spec.fields[0]).not.toHaveProperty('list');
    await post('info', { id }, '2').expect(404);
    await post('save', {
      id,
      version: info.version,
      config: info.config,
    }).expect(200);
    await post('save-spec', { id, version: info.version, spec }).expect(409);
  });

  it('预览绑定配置和文件指纹，修改后拒绝，手改文件跳过，成功/改动状态正确', async () => {
    const spec = newSpec('fingerprint');
    const saved = (await post('save-spec', { spec }).expect(200)).body.data;
    let preview = (await post('preview-spec', { spec }).expect(200)).body.data;
    expect(
      preview.files.every((f: { action: string }) => f.action === 'create'),
    ).toBe(true);
    await post('write-spec', {
      spec: { ...spec, title: '改名' },
      fingerprint: preview.fingerprint,
    }).expect(409);
    const file = preview.files[0];
    const path = join(serverRoot, file.path);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '// 人工写入');
    await post('write-spec', { spec, fingerprint: preview.fingerprint }).expect(
      409,
    );
    preview = (await post('preview-spec', { spec }).expect(200)).body.data;
    expect(preview.files[0]).toMatchObject({
      action: 'skip-modified',
      previous: '// 人工写入',
    });
    const partial = (
      await post('write-spec', {
        spec,
        fingerprint: preview.fingerprint,
      }).expect(200)
    ).body.data;
    expect(partial.skipped).toContain(file.path);
    expect(await readFile(path, 'utf8')).toBe('// 人工写入');
    await writeFile(path, file.content);
    preview = (await post('preview-spec', { spec }).expect(200)).body.data;
    const written = (
      await post('write-spec', {
        spec,
        fingerprint: preview.fingerprint,
      }).expect(200)
    ).body.data;
    expect(written.failed).toEqual([]);
    expect(written.skipped).toEqual([]);
    const list = (await post('list', {}).expect(200)).body.data;
    expect(list.find((r: { id: string }) => r.id === saved.id).status).toBe(
      'generated',
    );
    const info = (await post('info', { id: saved.id }).expect(200)).body.data;
    await post('save-spec', {
      id: saved.id,
      version: info.version,
      spec: { ...spec, title: '配置改动' },
    }).expect(200);
    expect(
      (await post('list', {}).expect(200)).body.data.find(
        (r: { id: string }) => r.id === saved.id,
      ).status,
    ).toBe('modified');
  });

  it('CLI 与 MCP 校验/预览共用相同结果，缺少指纹拒绝，生产开关拒绝', async () => {
    const spec = newSpec('local');
    const file = join(root, 'local.json');
    await writeFile(file, JSON.stringify(spec));
    const config = app.get(AppConfigService);
    const spy = vi
      .spyOn(config, 'codegen', 'get')
      .mockReturnValue({ enabled: true, serverRoot, adminRoot, tenantId: '1' });
    try {
      const tools = new LocalCodegenTools(
        app.get(CodegenService),
        config,
        app.get(RequestContext),
        app.get(SystemDictionaryService),
      );
      const cli = await runCodegen([file, '--preview'], tools);
      const mcp = await callCodegenTool(tools, 'preview_spec', { spec });
      expect(JSON.parse(mcp.content[0].text)).toEqual(
        JSON.parse(JSON.stringify(cli)),
      );
      expect(await runCodegen([file, '--check'], tools)).toEqual({
        valid: true,
        errors: [],
      });
      await expect(runCodegen([file, '--write'], tools)).rejects.toThrow(
        '指纹',
      );
      spy.mockReturnValue({
        enabled: false,
        serverRoot,
        adminRoot,
        tenantId: '1',
      });
      await expect(tools.call('preview_spec', { spec })).rejects.toThrow(
        '开发环境',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('第二个项目失败时明确报告已写、失败及恢复办法', async () => {
    const spec = newSpec('failure');
    const preview = (await post('preview-spec', { spec }).expect(200)).body
      .data;
    const fs = await import('../src/modules/codegen/safe-writer.js');
    const original = fs.writeSafe;
    const spy = vi
      .spyOn(fs, 'writeSafe')
      .mockImplementation(async (path, content) => {
        if (path.startsWith(adminRoot)) throw new Error('模拟前端写盘失败');
        return original(path, content);
      });
    try {
      const result = (
        await post('write-spec', {
          spec,
          fingerprint: preview.fingerprint,
        }).expect(200)
      ).body.data;
      expect(result.written.length).toBeGreaterThan(0);
      expect(result.failed).toHaveLength(1);
      expect(result.recovery).toContain('Git 差异');
    } finally {
      spy.mockRestore();
    }
  });

  it('真实表导入 → SQL/文件预览 → 安全写入 → 执行生成迁移 → 主子表 CRUD', async () => {
    await ds.query('DROP TABLE IF EXISTS cgsource_customer_contact');
    await ds.query('DROP TABLE IF EXISTS cgsource_customer');
    await ds.query(
      "CREATE TABLE cgsource_customer (id bigint unsigned PRIMARY KEY AUTO_INCREMENT, name varchar(80) NOT NULL COMMENT '客户名称', enabled tinyint(1) NOT NULL DEFAULT 1, created_at datetime(3) NULL) COMMENT='客户'",
    );
    await ds.query(
      "CREATE TABLE cgsource_customer_contact (id bigint unsigned PRIMARY KEY AUTO_INCREMENT, customer_id bigint unsigned NOT NULL, phone varchar(30) NOT NULL COMMENT '电话') COMMENT='联系人'",
    );
    const tables = (await post('tables', {}).expect(200)).body.data;
    expect(
      tables.find((t: { table: string }) => t.table === 'cgsource_customer'),
    ).toMatchObject({ comment: '客户', fieldCount: 4 });
    const imported = (
      await post('import-spec', {
        tables: ['cgsource_customer', 'cgsource_customer_contact'],
      }).expect(200)
    ).body.data;
    expect(imported.errors).toEqual([]);
    const spec: ModuleSpec = imported.spec;
    expect(spec.fields.map((f) => f.property)).toEqual(['name', 'enabled']);
    expect(spec.fields.find((f) => f.property === 'enabled')!.type).toBe(
      'boolean',
    );
    spec.moduleName = 'cgprobe';
    spec.businessName = 'customer';
    spec.permissionPrefix = 'cgprobe:customer';
    spec.tableName = 'cgprobe_customer';
    spec.options = { ...spec.options, scopeEnabled: true };
    spec.children![0].tableName = 'cgprobe_customer_contact';
    spec.fields.push({
      property: 'credit',
      column: 'credit',
      label: '信用额度',
      type: 'money',
      precision: 14,
      scale: 2,
      nullable: true,
    });
    spec.children![0].fields.push({
      property: 'amount',
      column: 'amount',
      label: '联系人额度',
      type: 'money',
      precision: 14,
      scale: 2,
      nullable: true,
    });
    await ds.query('DROP TABLE IF EXISTS cgprobe_customer_contact');
    await ds.query('DROP TABLE IF EXISTS cgprobe_customer');
    const preview = (await post('preview-spec', { spec }).expect(200)).body
      .data;
    expect(preview.sql).toHaveLength(2);
    const result = (
      await post('write-spec', {
        spec,
        fingerprint: preview.fingerprint,
      }).expect(200)
    ).body.data;
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    const files = await Promise.all(
      preview.files
        .filter((f: { project: string }) => f.project === 'server')
        .map(async (f: { path: string }) => ({
          project: 'server' as const,
          path: f.path,
          content: await readFile(join(serverRoot, f.path), 'utf8'),
        })),
    );
    const loaded = loadGenerated([
      ...files.filter((f) => f.path.endsWith('.entity.ts')),
      ...files.filter((f) => f.path.endsWith('.controller.ts')),
      ...files.filter((f) => f.path.includes('migrations/')),
    ]);
    const entities = [...loaded.values()].flatMap((m) =>
      Object.entries(m)
        .filter(([name]) => name.endsWith('Entity'))
        .map(([, value]) => value as Type),
    );
    const controller = [...loaded.values()].find((m) => m.CustomerController)!
      .CustomerController as Type;
    const runner = ds.createQueryRunner();
    await runner.connect();
    try {
      for (const table of ['cgprobe_customer_contact', 'cgprobe_customer'])
        if (await runner.hasTable(table)) await runner.dropTable(table);
      for (const [path, module] of loaded)
        if (path.includes('migrations/')) {
          const Migration = Object.values(
            module,
          )[0] as new () => MigrationInterface;
          await new Migration().up(runner);
        }
    } finally {
      await runner.release();
    }
    const schema = (await post('schema-spec', { spec }).expect(200)).body.data;
    @Module({
      imports: [AppModule, TypeOrmModule.forFeature(entities)],
      controllers: [controller],
    })
    class GeneratedTestModule {}
    @Injectable()
    class GeneratedCustomerScopeSource extends PermissionSource {
      async loadGrants(_tenant: string, user: string): Promise<RoleGrant[]> {
        if (user !== '200' && user !== '300')
          return [
            {
              roleId: 'generated-super',
              scopeOrgId: null,
              permissions: [],
              allPermissions: true,
              dataScope: 'all',
            },
          ];
        return [
          {
            roleId: `generated-org-${user}`,
            scopeOrgId: user === '200' ? '11' : '22',
            permissions: ['page', 'info', 'add', 'update', 'delete'].map(
              (action) => `cgprobe:customer:${action}`,
            ),
            dataScope: 'org',
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
    const module = await createTestModule({
      imports: [GeneratedTestModule],
    })
      .overrideProvider(PermissionSource)
      .useClass(GeneratedCustomerScopeSource)
      .compile();
    const generated = module.createNestApplication();
    configureApp(generated);
    await generated.init();
    try {
      const api = (action: string, body: object) =>
        request(generated.getHttpServer())
          .post(`/admin/cgprobe/customer/${action}`)
          .send(body);
      const actual = (
        await request(generated.getHttpServer())
          .get('/admin/cgprobe/customer/schema')
          .expect(200)
      ).body.data;
      expect(actual.columns).toEqual(schema.columns);
      expect(actual.children).toEqual(schema.children);
      const added = (
        await api('add', {
          data: { name: '客户甲', enabled: true, credit: 50000 },
          children: {
            customerContact: {
              added: [{ clientId: 'c1', phone: '13812345678', amount: 12.34 }],
            },
          },
        }).expect(200)
      ).body.data;
      const info = (await api('info', { id: added.id }).expect(200)).body.data;
      expect(info.children.customerContact[0].phone).toBe('13812345678');
      expect(info.credit).toBe('50000.00');
      expect(info.children.customerContact[0].amount).toBe('12.34');
      const invalidCredit = await api('update', {
        id: info.id,
        version: info.version,
        data: { credit: '1.001' },
      }).expect(400);
      expect(JSON.stringify(invalidCredit.body)).toContain(
        '信用额度最多 12 位整数、2 位小数',
      );
      const invalidChild = await api('update', {
        id: info.id,
        version: info.version,
        data: {},
        children: {
          customerContact: {
            updated: [
              { id: info.children.customerContact[0].id, amount: '1.001' },
            ],
          },
        },
      }).expect(400);
      expect(JSON.stringify(invalidChild.body)).toContain(
        '联系人额度最多 12 位整数、2 位小数',
      );
      await api('update', {
        id: info.id,
        version: info.version,
        data: { name: '客户乙', credit: '60000.01' },
        children: {
          customerContact: {
            updated: [
              {
                id: info.children.customerContact[0].id,
                phone: '13912345678',
                amount: 15.5,
              },
            ],
          },
        },
      }).expect(200);
      const updated = (await api('info', { id: info.id }).expect(200)).body
        .data;
      expect(updated.name).toBe('客户乙');
      expect(updated.credit).toBe('60000.01');
      expect(updated.children.customerContact[0].amount).toBe('15.50');
      expect(updated.children.customerContact[0].phone).toBe('13912345678');
      const page = (await api('page', {}).expect(200)).body.data;
      expect(page.total).toBe(1);
      await api('delete', { ids: [info.id] }).expect(200);
      await api('info', { id: info.id }).expect(404);
      const scoped = (
        user: string,
        org: string,
        action: string,
        body: object,
      ) =>
        request(generated.getHttpServer())
          .post(`/admin/cgprobe/customer/${action}`)
          .set('x-test-user', user)
          .set('x-test-org', org)
          .send(body);
      const orgA = (
        await scoped('200', '11', 'add', {
          data: { name: '组织甲', enabled: true },
          children: {
            customerContact: {
              added: [{ clientId: 'org-a', phone: '13800000001' }],
            },
          },
        }).expect(200)
      ).body.data;
      const orgB = (
        await scoped('300', '22', 'add', {
          data: { name: '组织乙', enabled: true },
          children: {
            customerContact: {
              added: [{ clientId: 'org-b', phone: '13800000002' }],
            },
          },
        }).expect(200)
      ).body.data;
      const ownA = (await scoped('200', '11', 'page', {}).expect(200)).body
        .data;
      expect(ownA.list.map((row: { name: string }) => row.name)).toEqual([
        '组织甲',
      ]);
      expect(
        (await scoped('300', '22', 'page', {}).expect(200)).body.data.list.map(
          (row: { name: string }) => row.name,
        ),
      ).toEqual(['组织乙']);
      await scoped('200', '11', 'info', { id: orgB.id }).expect(404);
      await scoped('200', '11', 'update', {
        id: orgB.id,
        version: orgB.version,
        data: { name: '越权' },
      }).expect(404);
      expect(
        (await scoped('200', '11', 'info', { id: orgA.id }).expect(200)).body
          .data.children.customerContact[0].phone,
      ).toBe('13800000001');
    } finally {
      await generated.close();
    }
    expect(
      renderServer(specToConfig(spec), 1).some((f) =>
        f.path.includes('customer_contact.entity.ts'),
      ),
    ).toBe(true);
  });
});
