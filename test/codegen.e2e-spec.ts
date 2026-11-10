/* eslint-disable typescript/no-misused-spread -- 规格和 DTO 在这些测试中均为 JSON 字面量，不含类实例方法。 */
import { Module, type INestApplication, type Type } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, type MigrationInterface } from 'typeorm';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
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
    for (const file of ['page.vue.tpl', 'locale.ts.tpl'])
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
      expect(result.failed).toHaveLength(2);
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
    spec.children![0].tableName = 'cgprobe_customer_contact';
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
    const module = await createTestModule({
      imports: [GeneratedTestModule],
    }).compile();
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
          data: { name: '客户甲', enabled: true },
          children: {
            customerContact: {
              added: [{ clientId: 'c1', phone: '13812345678' }],
            },
          },
        }).expect(200)
      ).body.data;
      const info = (await api('info', { id: added.id }).expect(200)).body.data;
      expect(info.children.customerContact[0].phone).toBe('13812345678');
      await api('update', {
        id: info.id,
        version: info.version,
        data: { name: '客户乙' },
        children: {
          customerContact: {
            updated: [
              { id: info.children.customerContact[0].id, phone: '13912345678' },
            ],
          },
        },
      }).expect(200);
      const updated = (await api('info', { id: info.id }).expect(200)).body
        .data;
      expect(updated.name).toBe('客户乙');
      expect(updated.children.customerContact[0].phone).toBe('13912345678');
      const page = (await api('page', {}).expect(200)).body.data;
      expect(page.total).toBe(1);
      await api('delete', { ids: [info.id] }).expect(200);
      await api('info', { id: info.id }).expect(404);
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
