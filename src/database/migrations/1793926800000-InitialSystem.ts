import {
  Table,
  type MigrationInterface,
  type QueryRunner,
  type TableColumnOptions,
} from 'typeorm';

const base: TableColumnOptions[] = [
  {
    name: 'id',
    type: 'bigint',
    unsigned: true,
    isPrimary: true,
    isGenerated: true,
    generationStrategy: 'increment',
  },
  { name: 'tenant_id', type: 'bigint', unsigned: true, default: '1' },
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
    generatedType: 'STORED',
    asExpression: 'IF(`deleted_at` IS NULL, 1, NULL)',
  },
  { name: 'delete_batch', type: 'char', length: '36', isNullable: true },
];
const text = (
  name: string,
  length: number,
  isNullable = false,
): TableColumnOptions => ({
  name,
  type: 'varchar',
  length: String(length),
  isNullable,
});
const id = (name: string, isNullable = false): TableColumnOptions => ({
  name,
  type: 'bigint',
  unsigned: true,
  isNullable,
});
const flag = (name: string, enabled: boolean): TableColumnOptions => ({
  name,
  type: 'tinyint',
  default: enabled ? '1' : '0',
});

/** 初始账号数据的表结构；不自动执行，不触碰其他项目数据库。 */
export class InitialSystem1793926800000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    // MySQL 生成列需要 ORM 的元数据表；迁移不会自动创建它。
    await runner.createTable(
      new Table({
        name: 'typeorm_metadata',
        columns: ['type', 'database', 'schema', 'table', 'name', 'value'].map(
          (name) => ({
            name,
            type: name === 'value' ? 'text' : 'varchar',
            ...(name === 'value' ? {} : { length: '255' }),
            isNullable: name !== 'type',
          }),
        ),
      }),
      true,
    );
    const definitions: [string, TableColumnOptions[], string?][] = [
      [
        'sys_user',
        [
          text('username', 64),
          text('password_hash', 100),
          text('nickname', 100),
          text('avatar', 500, true),
          flag('enabled', true),
          { ...text('locale', 16), default: "'zh-CN'" },
          id('default_org_id', true),
        ],
        'username',
      ],
      [
        'sys_org',
        [
          text('name', 100),
          id('parent_id', true),
          flag('enabled', true),
          { name: 'rank', type: 'int', default: '0' },
        ],
      ],
      [
        'sys_role',
        [
          text('code', 64),
          text('name', 100),
          flag('enabled', true),
          flag('all_permissions', false),
          { name: 'permissions', type: 'json' },
          text('data_scope', 24),
          { name: 'custom_org_ids', type: 'json' },
        ],
        'code',
      ],
      [
        'sys_user_role',
        [id('user_id'), id('role_id'), id('scope_org_id', true)],
      ],
      [
        'sys_menu',
        [
          id('parent_id', true),
          text('type', 16),
          text('path', 200),
          text('title', 100),
          text('icon', 100, true),
          { name: 'rank', type: 'int', default: '0' },
          text('component', 200, true),
          text('permission', 200, true),
          flag('keep_alive', false),
          flag('hidden', false),
        ],
      ],
    ];
    for (const [name, columns, unique] of definitions) {
      const existing = await runner.getTable(name);
      if (existing) {
        const expected = [...base, ...columns];
        if (
          existing.columns.length !== expected.length ||
          expected.some((column) => {
            const actual = existing.findColumnByName(column.name);
            return (
              !actual ||
              actual.type !== column.type ||
              actual.isNullable !== !!column.isNullable ||
              actual.unsigned !== !!column.unsigned ||
              (column.length !== undefined && actual.length !== column.length)
            );
          }) ||
          (unique &&
            !existing.indices.some(
              (index) =>
                index.isUnique &&
                index.columnNames.join(',') ===
                  `tenant_id,${unique},active_guard`,
            ))
        )
          throw new Error(`${name} 已存在但结构不符，拒绝自动修改`);
        // MySQL DDL 不回滚：允许在结构完全一致时继续中断的本地迁移，不删除数据。
        await runner.query(
          'INSERT INTO typeorm_metadata (`type`, `schema`, `table`, `name`, `value`) SELECT ?, DATABASE(), ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM typeorm_metadata WHERE `type` = ? AND `table` = ? AND `name` = ?)',
          [
            'GENERATED_COLUMN',
            name,
            'active_guard',
            'IF(`deleted_at` IS NULL, 1, NULL)',
            'GENERATED_COLUMN',
            name,
            'active_guard',
          ],
        );
        continue;
      }
      await runner.createTable(
        new Table({
          name,
          columns: [...base.map((column) => ({ ...column })), ...columns],
          indices: [
            { name: `ix_${name}_tenant`, columnNames: ['tenant_id'] },
            { name: `ix_${name}_org`, columnNames: ['org_id'] },
            ...(unique
              ? [
                  {
                    name: `uq_${name}_${unique}`,
                    columnNames: ['tenant_id', unique, 'active_guard'],
                    isUnique: true,
                  },
                ]
              : []),
            ...(name === 'sys_user_role'
              ? [
                  {
                    name: 'ix_sys_user_role_user',
                    columnNames: ['tenant_id', 'user_id'],
                  },
                ]
              : []),
          ],
        }),
      );
    }
  }

  async down(): Promise<void> {
    throw new Error(
      '初始系统表含账号与权限，禁止自动删除；回退需要人工备份与确认',
    );
  }
}
