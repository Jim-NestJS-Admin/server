import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BusinessException } from '../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../core/exceptions/error-code.js';
import { renderServer, type GeneratedFile } from './render-server.js';
import {
  loadAdminTemplates,
  manualSteps,
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
    private readonly config: ConfigService,
  ) {}

  /** 预览、写入、下载共用同一份文件集合：后端文件 + 前端文件（模板来自前端项目 codegen-templates/） */
  private async render(
    config: CodegenConfig,
    stamp: number,
  ): Promise<GeneratedFile[]> {
    let templates;
    try {
      templates = await loadAdminTemplates(this.roots().admin);
    } catch (e) {
      throw crudErrors.badRequest((e as Error).message);
    }
    try {
      return [
        ...renderServer(config, stamp),
        ...renderAdmin(config, templates),
      ];
    } catch (e) {
      throw crudErrors.badRequest((e as Error).message);
    }
  }

  private roots() {
    return {
      server: this.config.get<string>('CODEGEN_SERVER_ROOT') ?? '',
      admin: this.config.get<string>('CODEGEN_ADMIN_ROOT') ?? '',
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
    const config = row.config as CodegenConfig;
    const stamp = row.createdAt.getTime();
    const files = await this.render(config, stamp);
    const roots = this.roots();
    const last = row.fingerprints ?? {};
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
      items.push({ ...f, abs, key, now, next, action });
    }
    const token = createHash('sha256')
      .update(
        JSON.stringify([
          row.id,
          row.version,
          items.map((i) => [i.key, i.now, i.next]),
        ]),
      )
      .digest('base64url');
    return { row, items, token };
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
    const config = row.config as CodegenConfig;
    const files = await this.render(config, row.createdAt.getTime());
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
    const { row, items, token } = await this.plan(id);
    const steps = manualSteps(row.config as CodegenConfig);
    return {
      token,
      files: items.map((i) => ({
        project: i.project,
        path: i.path,
        action: i.action,
        content: i.content,
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
    const { row, items, token: current } = await this.plan(id);
    if (current !== token)
      throw new BusinessException(
        ErrorCode.Conflict,
        '预览之后文件或配置有变化，请重新预览',
        409,
      );
    const written: string[] = [];
    const skipped: string[] = [];
    const failed: { path: string; message: string }[] = [];
    const prints: Record<string, string> = { ...row.fingerprints };
    for (const i of items) {
      if (i.action === 'unchanged') {
        prints[i.key] = i.next;
        continue;
      }
      if (i.action === 'skip-modified' && !overwrite.includes(i.path)) {
        skipped.push(i.path);
        continue;
      }
      try {
        await writeSafe(i.abs, i.content);
        prints[i.key] = i.next;
        written.push(i.path);
      } catch (e) {
        failed.push({ path: i.path, message: (e as Error).message });
      }
    }
    await this.repo().update([row.id], { fingerprints: prints });
    return {
      written,
      skipped,
      failed,
      manualSteps: manualSteps(row.config as CodegenConfig),
    };
  }

  private repo() {
    return this.repos.for(CodegenEntity);
  }

  async list() {
    const rows = await this.repo().query('g').orderBy('g.id', 'DESC').getMany();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      label: r.label,
      version: r.version,
      updatedAt: r.updatedAt,
    }));
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
      config: row.config as CodegenConfig,
    };
  }

  /** 新建（id 为空）或修改（带 version，乐观锁） */
  async save(id: string | null, version: number | null, config: unknown) {
    const errors = validateCodegenConfig(config);
    if (errors.length) throw crudErrors.badRequest('生成配置不合法', errors);
    const c = config as CodegenConfig;
    const values = {
      name: `${c.module}.${c.business}`,
      label: c.label,
      config: c,
    };
    if (!id) return { id: await this.repo().insert(values) };
    const cur = await this.info(id);
    if (cur.version !== version) throw crudErrors.versionConflict();
    await this.repo().update([id], values);
    return { id };
  }

  async remove(id: string) {
    await this.info(id);
    await this.repo().remove([id]);
    return null;
  }

  /** 当前数据库里的表（排除已经有生成配置的） */
  async tables() {
    const rows: { table: string; comment: string }[] =
      await this.dataSource.query(
        'SELECT TABLE_NAME AS `table`, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = ? ORDER BY TABLE_NAME',
        ['BASE TABLE'],
      );
    const used = new Set(
      (await this.repo().query('g').getMany()).map(
        (g) => (g.config as CodegenConfig).table,
      ),
    );
    return rows.filter(
      (r) => !used.has(r.table) && !r.table.startsWith('sys_'),
    );
  }

  private async columns(table: string): Promise<CodegenField[]> {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(table))
      throw crudErrors.badRequest('表名格式不对');
    const cols: {
      name: string;
      dataType: string;
      columnType: string;
      nullable: string;
      length: number | null;
      comment: string;
      key: string;
    }[] = await this.dataSource.query(
      'SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable, CHARACTER_MAXIMUM_LENGTH AS length, COLUMN_COMMENT AS comment, COLUMN_KEY AS `key` FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [table],
    );
    if (!cols.length) throw crudErrors.notFound();
    return cols
      .filter((c) => !BASE_COLUMNS.has(c.name))
      .map((c) => {
        const type = mapColumnType(c.dataType, c.columnType);
        return {
          name: toCamel(c.name),
          column: c.name,
          label: (c.comment || c.name).slice(0, 30),
          type,
          length:
            type === 'string' && c.length
              ? Math.min(Number(c.length), 4000)
              : undefined,
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
      label: business,
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
