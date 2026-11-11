import { formatFiles } from './format-files.js';
import { stableStringify } from '../../core/swagger/swagger.js';
import { textDiff } from './text-diff.js';
import { CrudRuntime } from '../../core/crud/crud.runtime.js';
import { readFile } from 'node:fs/promises';
import {
  FIELD_CATALOG,
  readSpec,
  specToConfig,
  migrateLegacyConfig,
  validateSpec,
  type ModuleSpec,
} from './module-spec.js';
import { specSchema } from './spec-schema.js';
import { planMigrations } from './migration-plan.js';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { AppConfigService } from '../../core/config/app-config.service.js';
import { DataSource, QueryFailedError } from 'typeorm';
import { BusinessException } from '../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../core/exceptions/error-code.js';
import { renderServer, pascal } from './render-server.js';
import {
  loadAdminTemplates,
  contextualSteps,
  renderAdmin,
} from './render-admin.js';
import {
  currentFingerprint,
  fingerprint,
  resolveSafe,
  writeSafe,
} from './safe-writer.js';
import { crudErrors } from '../../core/crud/crud.errors.js';
import { TenantRepositoryFactory } from '../../core/tenant/tenant-repository.js';
import { CodegenEntity } from './codegen.entity.js';
import {
  mapColumnType,
  toCamel,
  validateCodegenConfig,
  type CodegenConfig,
  type CodegenField,
} from './codegen.types.js';

/** 框架基类自带的列：导入表时不生成字段 */
const BASE_COLUMNS = new Set([
  'id',
  'tenant_id',
  'org_id',
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
  'deleted_at',
  'version',
  'active_guard',
  'delete_batch',
]);

/** 代码生成配置的存取、导入表、同步表结构（T21 第一步）。只读数据库结构，不执行建表语句 */
@Injectable()
export class CodegenService {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
    private readonly runtime: CrudRuntime,
  ) {}

  /** 预览、写入、下载共用同一份文件集合：后端文件 + 前端文件（模板来自前端项目 codegen-templates/） */
  private async render(config: CodegenConfig, stamp: number) {
    let templates;
    try {
      templates = await loadAdminTemplates(this.roots().admin);
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      throw crudErrors.badRequest((e as Error).message);
    }
    try {
      const migrations = await planMigrations(this.dataSource, config, stamp);
      const files = [
        ...renderServer(config, stamp),
        ...renderAdmin(config, templates),
      ];
      migrations.forEach((plan, index) => {
        if (!plan.existing) return;
        const path = `src/database/migrations/${stamp + index}-Create${pascal(plan.table)}.ts`;
        const at = files.findIndex((file) => file.path === path);
        if (at >= 0) files.splice(at, 1);
        if (plan.file) files.push(plan.file);
      });
      return { files: await formatFiles(files, this.roots()), migrations };
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      throw crudErrors.badRequest((e as Error).message);
    }
  }

  private roots() {
    return {
      server: this.config.codegen.serverRoot,
      admin: this.config.codegen.adminRoot,
    };
  }

  /**
   * 生成计划：每个文件要新建、覆盖（上次生成后没人改过）还是跳过（已经存在且被手改过 / 不是本生成器写的）。
   * token 绑定配置版本和每个文件当前、将写入的指纹；写入时重算，不一致说明预览后文件又变了。
   */
  private async plan(id: string) {
    const row = await this.repo()
      .query('g')
      .andWhere('g.id = :id', { id })
      .getOne();
    if (!row) throw crudErrors.notFound();
    return this.buildPlan(this.storedSpec(row.config), row);
  }

  private async buildPlan(spec: ModuleSpec, row: CodegenEntity | null) {
    this.assertSpec(spec);
    const config = specToConfig(spec);
    const stamp = this.stamp(spec, row);
    const { files, migrations } = await this.render(config, stamp);
    const roots = this.roots();
    const last = row?.fingerprints ?? {};
    const items = [];
    for (const f of files) {
      let abs: string;
      try {
        abs = resolveSafe(roots[f.project], f.project, f.path);
      } catch (e) {
        throw crudErrors.badRequest((e as Error).message);
      }
      const now = await currentFingerprint(abs);
      const next = fingerprint(f.content);
      const key = `${f.project}:${f.path}`;
      const action =
        now === null
          ? 'create'
          : now === next
            ? 'unchanged'
            : last[key] === now
              ? 'overwrite'
              : 'skip-modified';
      const previous = now === null ? '' : await readFile(abs, 'utf8');
      items.push({
        ...f,
        abs,
        key,
        now,
        next,
        action,
        previous,
        diff: textDiff(f.path, previous, f.content),
      });
    }
    const token = createHash('sha256')
      .update(
        JSON.stringify([
          row?.id ?? null,
          row?.version ?? null,
          spec,
          migrations.map((plan) => [plan.table, plan.snapshot]),
          items.map((i) => [i.key, i.now, i.next]),
        ]),
      )
      .digest('base64url');
    return {
      row,
      items,
      token,
      spec,
      sql: migrations.map((plan) => plan.sql.join('\n')),
      steps: await contextualSteps(
        config,
        roots,
        items
          .filter((item) => item.action !== 'unchanged')
          .map((item) => item.path),
      ),
    };
  }

  /**
   * 下载压缩包：和预览同样的文件，按 server/、admin/ 分目录；路径照样经过白名单校验（不依赖本机目录）。
   */
  async download(id: string): Promise<{ name: string; zip: Uint8Array }> {
    const row = await this.repo()
      .query('g')
      .andWhere('g.id = :id', { id })
      .getOne();
    if (!row) throw crudErrors.notFound();
    const config = specToConfig(this.storedSpec(row.config));
    const { files } = await this.render(
      config,
      this.stamp(this.storedSpec(row.config), row),
    );
    const entries: Record<string, Uint8Array> = {};
    for (const f of files) {
      const rel = f.path;
      if (
        rel.includes('..') ||
        rel.includes('\\') ||
        rel.includes(':') ||
        rel.startsWith('/')
      )
        throw crudErrors.badRequest(`路径不合法：${rel}`);
      entries[`${f.project}/${rel}`] = strToU8(f.content);
    }
    return {
      name: `${config.module}-${config.business}.zip`,
      zip: zipSync(entries),
    };
  }

  async preview(id: string) {
    const plan = await this.plan(id);
    return this.previewResult(plan);
  }

  private previewResult({
    items,
    token,
    spec,
    sql,
    steps,
  }: Awaited<ReturnType<CodegenService['buildPlan']>>) {
    return {
      token,
      fingerprint: token,
      spec,
      sql,
      files: items.map((i) => ({
        project: i.project,
        path: i.path,
        key: i.key,
        action: i.action,
        content: i.content,
        previous: i.previous,
        diff: i.diff,
      })),
      note: `写入后还要人工完成：${steps.join('；')}`,
      manualSteps: steps,
    };
  }

  /**
   * 写入：先重算计划并核对 token（预览后文件被改过就 409），再按「后端、前端」顺序逐个写；
   * 手改过的文件只有在 overwrite 里点名才覆盖。返回每个文件的结果，并记下写入后的指纹。只写文件，不执行任何命令。
   */
  async write(id: string, token: string, overwrite: string[]) {
    return this.writePlan(await this.plan(id), token, overwrite);
  }

  private async writePlan(
    plan: Awaited<ReturnType<CodegenService['buildPlan']>>,
    token: string,
    overwrite: string[],
  ) {
    const { row, items, token: current, spec } = plan;
    if (current !== token)
      throw new BusinessException(
        ErrorCode.Conflict,
        '预览之后文件或配置有变化，请重新预览',
        409,
      );
    if (
      !Array.isArray(overwrite) ||
      overwrite.length > 50 ||
      overwrite.some((key) => typeof key !== 'string') ||
      new Set(overwrite).size !== overwrite.length ||
      overwrite.some(
        (key) => !items.some((item) => item.key === key || item.path === key),
      )
    )
      throw crudErrors.badRequest('覆盖列表含有预览之外的文件');
    const written: string[] = [];
    const skipped: string[] = [];
    const failed: { path: string; message: string }[] = [];
    const prints: Record<string, string> = {
      ...row?.fingerprints,
      $stamp: String(this.stamp(spec, row)),
    };
    for (const i of items) {
      try {
        // 每个文件落盘前再次检查真实路径和内容，链接被替换也必须报告失败。
        if (
          resolveSafe(this.roots()[i.project], i.project, i.path) !== i.abs ||
          (await currentFingerprint(i.abs)) !== i.now
        )
          throw new Error('预览后文件或路径发生变化，请重新预览');
        if (i.action === 'unchanged') {
          prints[i.key] = i.next;
          continue;
        }
        if (
          i.action === 'skip-modified' &&
          !overwrite.includes(i.key) &&
          !overwrite.includes(i.path)
        ) {
          skipped.push(i.path);
          continue;
        }
        await writeSafe(i.abs, i.content);
        prints[i.key] = i.next;
        written.push(i.path);
      } catch (e) {
        failed.push({ path: i.path, message: (e as Error).message });
      }
    }
    if (!failed.length && !skipped.length)
      prints['$spec'] = this.specHash(spec);
    else delete prints['$spec'];
    if (row)
      await this.repo().update([row.id], {
        fingerprints: prints,
        config: spec,
        label: spec.title,
      });
    else
      await this.repo().insert({
        name: `${spec.moduleName}.${spec.businessName}`,
        label: spec.title,
        config: spec,
        fingerprints: prints,
      });
    return {
      recovery:
        '文件不会自动回滚；按 written 检查 Git 差异，保留所需修改，再预览重试 failed/skipped。不会执行迁移或提交。',
      written,
      skipped,
      failed,
      manualSteps: await contextualSteps(
        specToConfig(spec),
        this.roots(),
        written,
      ),
    };
  }

  private repo() {
    return this.repos.for(CodegenEntity);
  }

  async list() {
    const rows = await this.repo().query('g').orderBy('g.id', 'DESC').getMany();
    return rows.map((r) => {
      const record = {
        id: r.id,
        name: r.name,
        label: r.label,
        version: r.version,
        updatedAt: r.updatedAt,
      };
      try {
        const spec = readSpec(r.config);
        this.assertSpec(spec);
        return {
          ...record,
          spec,
          status:
            !r.fingerprints || !Object.keys(r.fingerprints).length
              ? 'notGenerated'
              : r.fingerprints['$spec'] === this.specHash(spec)
                ? 'generated'
                : 'modified',
        };
      } catch {
        return {
          ...record,
          status: 'invalid',
          error: '配置无法解析，请修复或删除此记录；其他记录不受影响',
        };
      }
    });
  }

  async info(id: string) {
    const row = await this.repo()
      .query('g')
      .andWhere('g.id = :id', { id })
      .getOne();
    if (!row) throw crudErrors.notFound();
    return {
      id: row.id,
      version: row.version,
      config: specToConfig(this.storedSpec(row.config)),
      spec: this.storedSpec(row.config),
    };
  }

  /** 新建（id 为空）或修改（带 version，乐观锁） */
  async save(id: string | null, version: number | null, config: unknown) {
    const errors = validateCodegenConfig(config);
    if (errors.length) throw crudErrors.badRequest('生成配置不合法', errors);
    return this.saveSpec(
      id,
      version,
      migrateLegacyConfig(config as CodegenConfig),
    );
  }

  async remove(id: string) {
    const row = await this.repo()
      .query('g')
      .andWhere('g.id = :id', { id })
      .getOne();
    if (!row) throw crudErrors.notFound();
    await this.repo().remove([id]);
    return null;
  }

  /** 当前数据库里的表（排除已经有生成配置的） */
  async tables() {
    const rows: { table: string; comment: string; fieldCount: number }[] =
      await this.dataSource.query(
        'SELECT TABLE_NAME AS `table`, TABLE_COMMENT AS comment, (SELECT COUNT(*) FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME) AS fieldCount FROM information_schema.TABLES t WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = ? ORDER BY TABLE_NAME',
        ['BASE TABLE'],
      );
    const used = new Set(
      (await this.repo().query('g').getMany()).flatMap((g) => {
        try {
          const spec = this.storedSpec(g.config);
          return [
            spec.tableName,
            ...(spec.children ?? []).map((child) => child.tableName),
          ];
        } catch {
          return [];
        }
      }),
    );
    return rows
      .filter((r) => !used.has(r.table) && this.importableTable(r.table))
      .map((r) => ({ ...r, fieldCount: Number(r.fieldCount) }));
  }

  private importableTable(table: string) {
    const frameworkTables = new Set([
      'migrations',
      'typeorm_metadata',
      'file_asset',
    ]);
    return !table.startsWith('sys_') && !frameworkTables.has(table);
  }

  async columns(table: string): Promise<CodegenField[]> {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(table) || !this.importableTable(table))
      throw crudErrors.badRequest('表名格式不对');
    const cols: {
      name: string;
      dataType: string;
      columnType: string;
      nullable: string;
      length: number | null;
      comment: string;
      key: string;
      precision: number | null;
      scale: number | null;
      defaultValue: string | number | null;
    }[] = await this.dataSource.query(
      'SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable, CHARACTER_MAXIMUM_LENGTH AS length, COLUMN_COMMENT AS comment, COLUMN_KEY AS `key`, NUMERIC_PRECISION AS `precision`, NUMERIC_SCALE AS scale, COLUMN_DEFAULT AS defaultValue FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [table],
    );
    if (!cols.length) throw crudErrors.notFound();
    return cols
      .filter((c) => !BASE_COLUMNS.has(c.name))
      .map((c) => {
        const type =
          c.dataType.toLowerCase() === 'bigint'
            ? 'reference'
            : mapColumnType(c.dataType, c.columnType);
        return {
          name: toCamel(c.name),
          column: c.name,
          label: (c.comment || c.name).slice(0, 30),
          type,
          length: type === 'string' && c.length ? Number(c.length) : undefined,
          ...(type === 'decimal'
            ? {
                precision: Number(c.precision ?? 14),
                scale: Number(c.scale ?? 4),
              }
            : {}),
          ...(c.defaultValue !== null &&
          c.defaultValue !== undefined &&
          !['text', 'json'].includes(type) &&
          !String(c.defaultValue).toUpperCase().includes('CURRENT_TIMESTAMP')
            ? {
                defaultValue:
                  type === 'boolean'
                    ? String(c.defaultValue).replace(/^'|'$/g, '') === '1'
                    : type === 'int'
                      ? Number(c.defaultValue)
                      : String(c.defaultValue).replace(/^'(.*)'$/, '$1'),
              }
            : {}),
          comment: c.comment,
          nullable: c.nullable === 'YES',
          list: type !== 'json',
          query: null,
          form: true,
          required: c.nullable !== 'YES',
          unique: c.key === 'UNI',
          component:
            type === 'boolean'
              ? 'switch'
              : type === 'int' || type === 'decimal' || type === 'money'
                ? 'number'
                : type === 'date' || type === 'datetime'
                  ? 'date'
                  : 'input',
        } satisfies CodegenField;
      });
  }

  /** 按表结构生成一份初始配置（不保存，前端改完再 save） */
  async importTable(table: string): Promise<CodegenConfig> {
    const fields = await this.columns(table);
    const [module, ...rest] = table.split('_');
    const business = rest.join('_') || module;
    return {
      module,
      business,
      label: (await this.tableTitle(table)) || business,
      permPrefix: `${module}:${business.replace(/_/g, '-')}`,
      table,
      template: 'single',
      options: {
        deleteMode: 'soft',
        formMode: 'dialog',
        export: true,
        import: false,
        dataScope: false,
      },
      fields,
    };
  }

  private async tableTitle(table: string): Promise<string> {
    const rows: { comment: string }[] = await this.dataSource.query(
      'SELECT TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [table],
    );
    return (rows[0]?.comment ?? '').slice(0, 30);
  }

  fieldTypes() {
    return FIELD_CATALOG;
  }

  private storedSpec(raw: unknown) {
    try {
      const spec = readSpec(raw);
      this.assertSpec(spec);
      return spec;
    } catch (error) {
      if (error instanceof BusinessException) throw error;
      throw crudErrors.badRequest('此生成记录配置无法解析，请修复或删除此记录');
    }
  }

  private assertSpec(spec: unknown): asserts spec is ModuleSpec {
    const errors = validateSpec(spec);
    if (errors.length)
      throw crudErrors.badRequest(
        '模块规格不合法',
        errors.map((e) => ({ field: e.path, messages: [e.message] })),
      );
  }

  private stamp(spec: ModuleSpec, row?: CodegenEntity | null) {
    if (row?.fingerprints?.['$stamp'])
      return Number(row.fingerprints['$stamp']);
    if (row) return row.createdAt.getTime();
    return (
      1790000000000 +
      parseInt(
        fingerprint(`${spec.moduleName}.${spec.businessName}`).slice(0, 9),
        16,
      )
    );
  }

  private specHash(spec: ModuleSpec) {
    return fingerprint(stableStringify(specToConfig(spec)));
  }

  private async specPlan(spec: ModuleSpec) {
    this.assertSpec(spec);
    const row = await this.repo()
      .query('g')
      .andWhere('g.name = :name', {
        name: `${spec.moduleName}.${spec.businessName}`,
      })
      .getOne();
    return this.buildPlan(spec, row);
  }

  async saveSpec(id: string | null, version: number | null, spec: ModuleSpec) {
    this.assertSpec(spec);
    const values = {
      name: `${spec.moduleName}.${spec.businessName}`,
      label: spec.title,
      config: spec,
    };
    const duplicate = () => {
      const message = `模块 ${values.name} 已有生成记录`;
      return crudErrors.badRequest(message, [
        { field: 'businessName', messages: [message] },
      ]);
    };
    try {
      if (!id) return { id: await this.repo().insert(values) };
      return await this.dataSource.transaction(async (manager) => {
        const current = await this.repo()
          .query('g', manager)
          .andWhere('g.id = :id', { id })
          .setLock('pessimistic_write')
          .getOne();
        if (!current) throw crudErrors.notFound();
        if (current.version !== version) throw crudErrors.versionConflict();
        await this.repo().update([id], values, manager);
        return { id };
      });
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string } | undefined)?.code ===
          'ER_DUP_ENTRY'
      )
        throw duplicate();
      throw error;
    }
  }

  async previewSpec(spec: ModuleSpec) {
    return this.previewResult(await this.specPlan(spec));
  }
  async writeSpec(spec: ModuleSpec, token: string, overwrite: string[] = []) {
    return this.writePlan(await this.specPlan(spec), token, overwrite);
  }

  async schemaSpec(spec: ModuleSpec) {
    this.assertSpec(spec);
    const schema = specSchema(spec);
    const fill = async (fields: ModuleSpec['fields'], prefix = '') => {
      for (const field of fields)
        if (field.dictCode)
          schema.dictionaries[`${prefix}${field.property}`] =
            await this.dictionaryOptions(field.dictCode);
    };
    await fill(spec.fields);
    for (let i = 0; i < (spec.children?.length ?? 0); i++)
      await fill(spec.children![i].fields, `${schema.children[i].resource}.`);
    return schema;
  }

  async dictionaryOptions(code: string) {
    return this.runtime.dictionary ? this.runtime.dictionary.options(code) : [];
  }

  async importSpec(tables: string[]) {
    if (
      !Array.isArray(tables) ||
      tables.length < 1 ||
      tables.length > 6 ||
      new Set(tables).size !== tables.length
    )
      throw crudErrors.badRequest('请选择 1 到 6 张不同的表');
    const configs = await Promise.all(
      tables.map((table) => this.importTable(table)),
    );
    const spec = migrateLegacyConfig(configs[0]);
    if (configs.length > 1) {
      spec.template = 'masterDetail';
      const parentKey = toCamel(`${configs[0].business}_id`);
      spec.children = configs.slice(1).map((c) => {
        const foreignKey = c.fields.some((f) => f.name === parentKey)
          ? parentKey
          : toCamel(`${configs[0].table}_id`);
        return {
          tableName: c.table,
          foreignKey,
          title: c.label,
          fields: migrateLegacyConfig(c).fields.filter(
            (f) => f.property !== foreignKey,
          ),
        };
      });
    }
    return { spec, errors: validateSpec(spec) };
  }

  /** 表结构和配置的差异：新增的列、配置里有但表里没有的列、类型变了的列 */
  async sync(id: string) {
    const { config } = await this.info(id);
    const actual = await this.columns(config.table);
    const byCol = new Map(config.fields.map((f) => [f.column, f]));
    const inTable = new Set(actual.map((f) => f.column));
    return {
      added: actual.filter((f) => !byCol.has(f.column)),
      removed: config.fields
        .filter((f) => !inTable.has(f.column))
        .map((f) => f.column),
      changed: actual
        .filter(
          (f) => byCol.has(f.column) && byCol.get(f.column)!.type !== f.type,
        )
        .map((f) => ({
          column: f.column,
          from: byCol.get(f.column)!.type,
          to: f.type,
        })),
    };
  }
}
