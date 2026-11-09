import {
  Table,
  type MigrationInterface,
  type QueryRunner,
  type TableColumnOptions,
  type TableIndexOptions,
} from 'typeorm';

/**
 * core 层的表（T10）：用户偏好（T18）、页面显示配置及历史（T23）、代码生成配置（T21）、幂等记录（T25）。
 * 列和实体一一对应；和 Codex 的系统表迁移互不依赖，合并后登记到 bootstrap-local 的 migrations 列表里，
 * 排在 SystemFields（1793941200000）之后。
 */

/** BaseEntity 的公共列（core/crud/base.entity.ts） */
const base = (): TableColumnOptions[] => [
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
  { name: 'version', type: 'int', unsigned: true },
  { name: 'deleted_at', type: 'datetime', precision: 3, isNullable: true },
  {
    name: 'active_guard',
    type: 'tinyint',
    isNullable: true,
    asExpression: 'IF(`deleted_at` IS NULL, 1, NULL)',
    generatedType: 'STORED',
  },
  { name: 'delete_batch', type: 'char', length: '36', isNullable: true },
];

const baseIndices = (table: string): TableIndexOptions[] => [
  { name: `idx_${table}_tenant`, columnNames: ['tenant_id'] },
  { name: `idx_${table}_org`, columnNames: ['org_id'] },
];

const varchar = (
  name: string,
  length: number,
  isNullable = false,
): TableColumnOptions => ({
  name,
  type: 'varchar',
  length: String(length),
  isNullable,
});

const json = (name: string, isNullable = false): TableColumnOptions => ({
  name,
  type: 'json',
  isNullable,
});

export class CoreTables1793944800000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.createTable(
      new Table({
        name: 'sys_user_pref',
        columns: [
          ...base(),
          { name: 'user_id', type: 'bigint', unsigned: true },
          varchar('scope', 32),
          varchar('key', 100),
          json('value'),
        ],
        indices: [
          ...baseIndices('sys_user_pref'),
          {
            name: 'uk_sys_user_pref',
            columnNames: [
              'tenant_id',
              'user_id',
              'scope',
              'key',
              'active_guard',
            ],
            isUnique: true,
          },
        ],
      }),
      true,
    );

    await q.createTable(
      new Table({
        name: 'sys_page_config',
        columns: [...base(), varchar('resource', 100), json('config')],
        indices: [
          ...baseIndices('sys_page_config'),
          {
            name: 'uk_sys_page_config',
            columnNames: ['tenant_id', 'resource', 'active_guard'],
            isUnique: true,
          },
        ],
      }),
      true,
    );

    await q.createTable(
      new Table({
        name: 'sys_page_config_history',
        columns: [
          ...base(),
          varchar('resource', 100),
          json('config', true),
          { name: 'config_version', type: 'int', unsigned: true },
        ],
        indices: [
          ...baseIndices('sys_page_config_history'),
          {
            name: 'idx_sys_page_config_history',
            columnNames: ['tenant_id', 'resource', 'created_at'],
          },
        ],
      }),
      true,
    );

    await q.createTable(
      new Table({
        name: 'sys_codegen',
        columns: [
          ...base(),
          varchar('name', 130),
          varchar('label', 30),
          json('config'),
          json('fingerprints', true),
        ],
        indices: [
          ...baseIndices('sys_codegen'),
          {
            name: 'uk_sys_codegen',
            columnNames: ['tenant_id', 'name', 'active_guard'],
            isUnique: true,
          },
        ],
      }),
      true,
    );

    // 幂等记录不继承 BaseEntity：只增不改，过期由下次同键写入时清理
    await q.createTable(
      new Table({
        name: 'sys_idempotency',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            unsigned: true,
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'tenant_id', type: 'bigint', unsigned: true },
          varchar('user_id', 32),
          varchar('idem_key', 64),
          varchar('owner', 255),
          varchar('digest', 64),
          json('result', true),
          {
            name: 'created_at',
            type: 'datetime',
            precision: 3,
            default: 'CURRENT_TIMESTAMP(3)',
          },
          { name: 'expires_at', type: 'datetime', precision: 3 },
        ],
        indices: [
          {
            name: 'uk_sys_idempotency',
            columnNames: ['tenant_id', 'user_id', 'idem_key'],
            isUnique: true,
          },
          { name: 'idx_sys_idempotency_expires', columnNames: ['expires_at'] },
        ],
      }),
      true,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    for (const t of [
      'sys_idempotency',
      'sys_codegen',
      'sys_page_config_history',
      'sys_page_config',
      'sys_user_pref',
    ])
      await q.dropTable(t, true);
  }
}
