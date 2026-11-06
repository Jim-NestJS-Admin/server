import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
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
  ) {}

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
