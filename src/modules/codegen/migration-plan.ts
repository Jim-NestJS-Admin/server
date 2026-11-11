import {
  Table,
  TableColumn,
  TableIndex,
  type DataSource,
  type TableColumnOptions,
  type TableIndexOptions,
} from 'typeorm';
import { createHash } from 'node:crypto';
import { crudErrors } from '../../core/crud/crud.errors.js';
import type { CodegenConfig } from './codegen.types.js';
import { tableDefinition } from './table-definition.js';
import { pascal, type GeneratedFile } from './render-server.js';

type Action =
  | { kind: 'addColumn'; column: TableColumnOptions }
  | { kind: 'changeColumn'; before: TableColumn; after: TableColumn }
  | { kind: 'createIndex' | 'dropIndex'; index: TableIndexOptions };
export interface TableMigrationPlan {
  table: string;
  existing: boolean;
  snapshot: unknown;
  sql: string[];
  file?: GeneratedFile;
}
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equivalent = (a: TableIndex, b: TableIndex) =>
  a.isUnique === b.isUnique &&
  a.columnNames.join(',') === b.columnNames.join(',');
const normalizedType = (t: string) =>
  t === 'boolean' || t === 'bool' ? 'tinyint' : t === 'integer' ? 'int' : t;

/** 现有字段只接受兼容结构；拒绝通过自动删列/重建列改变类型，避免丢失导入表的数据。 */
function compatible(actual: TableColumn, wanted: TableColumn) {
  return (
    normalizedType(actual.type) === normalizedType(wanted.type) &&
    actual.isNullable === wanted.isNullable &&
    actual.unsigned === wanted.unsigned &&
    actual.isPrimary === wanted.isPrimary &&
    actual.isGenerated === wanted.isGenerated &&
    (!wanted.length || actual.length === wanted.length) &&
    (wanted.precision === undefined ||
      (actual.precision ?? 0) === wanted.precision) &&
    (wanted.scale === undefined || (actual.scale ?? 0) === wanted.scale) &&
    (!wanted.asExpression ||
      (actual.asExpression ?? '').replace(/[\s`()]/g, '').toLowerCase() ===
        wanted.asExpression.replace(/[\s`()]/g, '').toLowerCase())
  );
}

function renderIncremental(
  table: string,
  actions: Action[],
  stamp: number,
  snapshot: unknown,
): GeneratedFile | undefined {
  if (!actions.length) return undefined;
  const suffix = hash([snapshot, actions]).slice(0, 10);
  const name = `Update${pascal(table)}${suffix}${stamp}`;
  const quoted = JSON.stringify(table);
  const statement = (action: Action, down: boolean) =>
    action.kind === 'addColumn'
      ? down
        ? `await q.dropColumn(${quoted}, ${JSON.stringify(action.column.name)});`
        : `await q.addColumn(${quoted}, new TableColumn(${JSON.stringify(action.column)}));`
      : action.kind === 'changeColumn'
        ? `await q.changeColumn(${quoted}, new TableColumn(${JSON.stringify(down ? action.after : action.before)}), new TableColumn(${JSON.stringify(down ? action.before : action.after)}));`
        : (action.kind === 'createIndex') !== down
          ? `await q.createIndex(${quoted}, new TableIndex(${JSON.stringify(action.index)}));`
          : `await q.dropIndex(${quoted}, ${JSON.stringify(action.index.name)});`;
  const imports = [
    ...(actions.some((a) => a.kind === 'addColumn' || a.kind === 'changeColumn')
      ? ['TableColumn']
      : []),
    ...(actions.some((a) => a.kind === 'createIndex' || a.kind === 'dropIndex')
      ? ['TableIndex']
      : []),
  ];
  return {
    project: 'server',
    path: `src/database/migrations/${stamp}-Update${pascal(table)}-${suffix}.ts`,
    content: `// 由代码生成器生成：已有表的增量迁移；保留原表和原数据，回退仅撤销本次变更。
import { ${imports.join(', ')}, type MigrationInterface, type QueryRunner } from 'typeorm';
export class ${name} implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!(await q.hasTable(${quoted}))) throw new Error('导入表不存在，请重新预览迁移');
${actions.map((a) => `    ${statement(a, false)}`).join('\n')}
  }
  async down(q: QueryRunner): Promise<void> {
${[...actions]
  .reverse()
  .map((a) => `    ${statement(a, true)}`)
  .join('\n')}
  }
}
`,
  };
}

/** QueryRunner 的 SQL 内存模式只构建 SQL；生成、预览和写文件均不会执行迁移。 */
export async function planMigrations(
  ds: DataSource,
  config: CodegenConfig,
  stamp: number,
): Promise<TableMigrationPlan[]> {
  const definitions = [
    tableDefinition(
      config,
      undefined,
      config.template === 'tree' ? config.tree?.parentField : undefined,
    ),
    ...(config.template === 'master-detail' ? (config.children ?? []) : []).map(
      (ch) =>
        tableDefinition({ table: ch.table, fields: ch.fields }, ch.foreignKey),
    ),
  ];
  const result: TableMigrationPlan[] = [];
  for (let i = 0; i < definitions.length; i++) {
    const definition = definitions[i],
      wanted = new Table(definition),
      runner = ds.createQueryRunner();
    await runner.connect();
    try {
      const current = await runner.getTable(wanted.name);
      const snapshot = current
        ? {
            columns: current.columns.map((c) => ({
              name: c.name,
              type: c.type,
              length: c.length,
              precision: c.precision,
              scale: c.scale,
              isNullable: c.isNullable,
              unsigned: c.unsigned,
              isPrimary: c.isPrimary,
              isGenerated: c.isGenerated,
              default: c.default as unknown,
              asExpression: c.asExpression,
            })),
            indices: current.indices.map((index) => ({
              name: index.name,
              columnNames: index.columnNames,
              isUnique: index.isUnique,
            })),
          }
        : null;
      runner.enableSqlMemory();
      const actions: Action[] = [];
      if (!current) await runner.createTable(wanted);
      else {
        const errors = wanted.columns.flatMap((column) => {
          const actual = current.findColumnByName(column.name);
          return actual && !compatible(actual, column)
            ? [
                {
                  field: `tables.${wanted.name}.${column.name}`,
                  messages: [
                    '已有字段结构与规格不兼容；请先确认独立的数据转换迁移，不自动删除或重建现有字段',
                  ],
                },
              ]
            : [];
        });
        if (current.primaryColumns.some((c) => c.name !== 'id'))
          errors.push({
            field: `tables.${wanted.name}.id`,
            messages: ['已有表主键必须为自增 bigint id，请先确认主键转换方案'],
          });
        if (errors.length)
          throw crudErrors.badRequest('导入表结构不兼容', errors);
        for (const column of wanted.columns)
          if (!current.findColumnByName(column.name)) {
            actions.push({
              kind: 'addColumn',
              column: definition.columns!.find((c) => c.name === column.name)!,
            });
            await runner.addColumn(wanted.name, column);
          }
        for (const column of wanted.columns) {
          const actual = current.findColumnByName(column.name);
          if (!actual) continue;
          const next = actual.clone();
          const normalizeDefault = (value: unknown) =>
            value == null || value === 'NULL'
              ? null
              : /^current_timestamp(?:\(\d*\))?$/i.test(
                    String(value as string | number | boolean),
                  )
                ? String(value as string).toLowerCase()
                : String(value as string | number | boolean).replace(
                    /^'(.*)'$/s,
                    '$1',
                  );
          // 仅修改常量默认值和注释；保留没有在规格中声明的既有默认值。
          if (
            column.default !== undefined &&
            normalizeDefault(column.default) !==
              normalizeDefault(actual.default)
          )
            next.default = column.default;
          if (
            definition.columns!.find((item) => item.name === column.name)
              ?.comment !== undefined &&
            column.comment !== actual.comment
          )
            next.comment = column.comment;
          if (
            next.default !== actual.default ||
            next.comment !== actual.comment
          ) {
            actions.push({ kind: 'changeColumn', before: actual, after: next });
            await runner.changeColumn(wanted.name, actual, next);
          }
        }
        // 原来的单字段唯一索引会阻止软删除后重用值；仅替换规格显式声明的单字段唯一约束。
        for (const field of (i === 0
          ? config.fields
          : config.children![i - 1].fields
        ).filter((f) => f.unique)) {
          for (const index of current.indices.filter(
            (idx) =>
              idx.isUnique &&
              idx.columnNames.length === 1 &&
              idx.columnNames[0] === field.column,
          )) {
            actions.push({
              kind: 'dropIndex',
              index: {
                name: index.name,
                columnNames: index.columnNames,
                isUnique: true,
              },
            });
            if (!/^[A-Za-z0-9_]{1,64}$/.test(index.name ?? ''))
              throw crudErrors.badRequest(
                '已有索引名称不受支持，请先规范索引名称',
              );
            await runner.dropIndex(wanted.name, index.name!);
          }
        }
        for (const index of wanted.indices) {
          if (current.indices.some((existing) => equivalent(existing, index)))
            continue;
          index.name ||= ds.namingStrategy.indexName(
            wanted.name,
            index.columnNames,
          );
          if (current.indices.some((existing) => existing.name === index.name))
            throw crudErrors.badRequest(
              `索引名称冲突：${wanted.name}.${index.name}`,
            );
          actions.push({
            kind: 'createIndex',
            index: {
              name: index.name,
              columnNames: index.columnNames,
              isUnique: index.isUnique,
            },
          });
          await runner.createIndex(wanted.name, index);
        }
      }
      const sql = runner
        .getMemorySql()
        .upQueries.map(
          (query) =>
            query.query +
            (query.parameters?.length
              ? `; -- 参数：${JSON.stringify(query.parameters)}`
              : ';'),
        );
      result.push({
        table: wanted.name,
        existing: !!current,
        snapshot,
        sql: sql.length
          ? sql
          : [`-- ${wanted.name} 已存在且结构匹配，无需变更表结构。`],
        ...(current
          ? {
              file: renderIncremental(
                wanted.name,
                actions,
                stamp + i,
                snapshot,
              ),
            }
          : {}),
      });
    } finally {
      runner.disableSqlMemory();
      await runner.release();
    }
  }
  return result;
}
