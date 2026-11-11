import type { TableColumnOptions, TableOptions } from 'typeorm';
import type { CodegenConfig, CodegenField } from './codegen.types.js';
import { sqlDefault, uniqueIndexName } from './sql-values.js';

const snake = (v: string) => v.replace(/[A-Z]/g, (s) => `_${s.toLowerCase()}`);

/** 渲染迁移和数据库增量计划共用的结构定义；不连接数据库、不执行 SQL。 */
export function tableDefinition(
  c: Pick<CodegenConfig, 'table' | 'fields'>,
  foreignKey?: string,
  treeParent?: string,
): TableOptions {
  const field = (f: CodegenField): TableColumnOptions => {
    const type =
      f.name === treeParent || f.type === 'reference'
        ? 'bigint'
        : f.type === 'text'
          ? 'text'
          : f.type === 'int'
            ? 'int'
            : f.type === 'decimal' || f.type === 'money'
              ? 'decimal'
              : f.type === 'date'
                ? 'date'
                : f.type === 'datetime'
                  ? 'datetime'
                  : f.type === 'boolean'
                    ? 'boolean'
                    : f.type === 'json'
                      ? 'json'
                      : 'varchar';
    return {
      name: f.column,
      type,
      ...(type === 'bigint' ? { unsigned: true } : {}),
      ...(type === 'varchar'
        ? {
            length: String(
              f.length ??
                (f.type === 'image' || f.type === 'file' ? 2048 : 255),
            ),
          }
        : {}),
      ...(type === 'decimal'
        ? {
            precision: f.precision ?? 14,
            scale: f.scale ?? (f.type === 'money' ? 2 : 4),
          }
        : {}),
      ...(type === 'datetime' ? { precision: 3 } : {}),
      isNullable: !!f.nullable || f.name === treeParent,
      comment: f.comment ?? f.label,
      ...(Object.hasOwn(f, 'defaultValue')
        ? { default: sqlDefault(f.defaultValue) }
        : {}),
    };
  };
  const parentColumn = c.fields.find((f) => f.name === treeParent)?.column;
  return {
    name: c.table,
    columns: [
      {
        name: 'id',
        type: 'bigint',
        unsigned: true,
        isPrimary: true,
        isGenerated: true,
        generationStrategy: 'increment',
      },
      { name: 'tenant_id', type: 'bigint', unsigned: true, default: "'1'" },
      { name: 'org_id', type: 'bigint', unsigned: true, isNullable: true },
      { name: 'created_by', type: 'bigint', unsigned: true, isNullable: true },
      { name: 'updated_by', type: 'bigint', unsigned: true, isNullable: true },
      {
        name: 'created_at',
        type: 'datetime',
        precision: 3,
        default: 'CURRENT_TIMESTAMP(3)',
      },
      {
        name: 'updated_at',
        type: 'datetime',
        precision: 3,
        default: 'CURRENT_TIMESTAMP(3)',
        onUpdate: 'CURRENT_TIMESTAMP(3)',
      },
      { name: 'version', type: 'int', unsigned: true, default: '1' },
      { name: 'deleted_at', type: 'datetime', precision: 3, isNullable: true },
      {
        name: 'active_guard',
        type: 'tinyint',
        isNullable: true,
        asExpression: 'IF(`deleted_at` IS NULL, 1, NULL)',
        generatedType: 'STORED',
      },
      { name: 'delete_batch', type: 'char', length: '36', isNullable: true },
      ...(foreignKey
        ? [{ name: snake(foreignKey), type: 'bigint', unsigned: true }]
        : []),
      ...c.fields.map(field),
    ],
    indices: [
      { columnNames: ['tenant_id'] },
      { columnNames: ['org_id'] },
      ...(foreignKey ? [{ columnNames: [snake(foreignKey)] }] : []),
      ...(parentColumn ? [{ columnNames: ['tenant_id', parentColumn] }] : []),
      ...c.fields
        .filter((f) => f.unique)
        .map((f) => ({
          name: uniqueIndexName(c.table, f.column),
          columnNames: ['tenant_id', f.column, 'active_guard'],
          isUnique: true,
        })),
    ],
  };
}
