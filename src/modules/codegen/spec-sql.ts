import {
  FIELD_CATALOG,
  type ModuleSpec,
  type SpecField,
} from './module-spec.js';
import { sqlDefault, uniqueIndexName } from './render-server.js';

const quote = (v: string) => `\`${v}\``;
const snake = (v: string) => v.replace(/[A-Z]/g, (s) => `_${s.toLowerCase()}`);

/** 只作预览，绝不执行；标识符先经规格校验，值按 MySQL 字面量转义。 */
export function migrationSql(spec: ModuleSpec): string[] {
  const table = (
    name: string,
    fields: SpecField[],
    foreignKey?: string,
    parent?: string,
  ) => {
    const columns = fields.map((f) => {
      const type =
        f.property === parent
          ? 'bigint unsigned'
          : f.type === 'reference'
            ? 'bigint unsigned'
            : FIELD_CATALOG.find((t) => t.type === f.type)!.databaseType;
      const sqlType =
        type === 'varchar'
          ? `${type}(${f.length ?? (f.type === 'image' || f.type === 'file' ? 2048 : 255)})`
          : type === 'decimal'
            ? `${type}(${f.precision ?? 14},${f.scale ?? (f.type === 'money' ? 2 : 4)})`
            : type === 'datetime'
              ? 'datetime(3)'
              : type;
      return `  ${quote(f.column)} ${sqlType} ${f.nullable || f.property === parent ? 'NULL' : 'NOT NULL'}${Object.hasOwn(f, 'defaultValue') ? ` DEFAULT ${sqlDefault(f.defaultValue)}` : ''} COMMENT ${sqlDefault(f.comment ?? f.label)}`;
    });
    return `CREATE TABLE ${quote(name)} (\n${[
      '  `id` bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY',
      "  `tenant_id` bigint unsigned NOT NULL DEFAULT '1'",
      '  `org_id` bigint unsigned NULL',
      '  `created_by` bigint unsigned NULL',
      '  `updated_by` bigint unsigned NULL',
      '  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
      '  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)',
      '  `version` int unsigned NOT NULL DEFAULT 1',
      '  `deleted_at` datetime(3) NULL',
      '  `active_guard` tinyint GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, 1, NULL)) STORED',
      '  `delete_batch` char(36) NULL',
      ...(foreignKey
        ? [`  ${quote(snake(foreignKey))} bigint unsigned NOT NULL`]
        : []),
      ...columns,
      '  INDEX (`tenant_id`)',
      '  INDEX (`org_id`)',
      ...(foreignKey ? [`  INDEX (${quote(snake(foreignKey))})`] : []),
      ...(parent
        ? [
            `  INDEX (\`tenant_id\`, ${quote(fields.find((f) => f.property === parent)!.column)})`,
          ]
        : []),
      ...fields
        .filter((f) => f.unique)
        .map(
          (f) =>
            `  UNIQUE KEY ${quote(uniqueIndexName(name, f.column))} (\`tenant_id\`, ${quote(f.column)}, \`active_guard\`)`,
        ),
    ].join(',\n')}\n);`;
  };
  return [
    table(spec.tableName, spec.fields, undefined, spec.tree?.parentField),
    ...(spec.children ?? []).map((ch) =>
      table(ch.tableName, ch.fields, ch.foreignKey),
    ),
  ];
}
