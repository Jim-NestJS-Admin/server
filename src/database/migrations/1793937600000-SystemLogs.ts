import {
  Table,
  type MigrationInterface,
  type QueryRunner,
  type TableColumnOptions,
} from 'typeorm';
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
const bool = (name: string, enabled?: boolean): TableColumnOptions => ({
  name,
  type: 'tinyint',
  ...(enabled === undefined ? {} : { default: enabled ? '1' : '0' }),
});
/** 字典、参数和日志表；审计原始快照为内部列，接口不直接读取。 */
export class SystemLogs1793937600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const source = await runner.getTable('sys_user');
    if (!source) throw new Error('请先运行T07初始迁移');
    const names = new Set([
      'id',
      'tenant_id',
      'org_id',
      'created_by',
      'updated_by',
      'created_at',
      'updated_at',
      'version',
      'deleted_at',
      'active_guard',
      'delete_batch',
    ]);
    const definitions: [string, TableColumnOptions[], string[]?][] = [
      [
        'sys_dict_type',
        [text('code', 64), text('name', 100), bool('enabled', true)],
        ['code'],
      ],
      [
        'sys_dict_item',
        [
          { name: 'type_id', type: 'bigint', unsigned: true },
          text('value', 100),
          text('label', 100),
          bool('enabled', true),
          { name: 'rank', type: 'int', default: '0' },
        ],
        ['type_id', 'value'],
      ],
      [
        'sys_parameter',
        [
          text('key', 128),
          { name: 'value', type: 'text' },
          text('description', 500, true),
        ],
        ['key'],
      ],
      [
        'sys_operation_log',
        [
          text('action', 200),
          text('resource', 200),
          text('method', 12),
          bool('success'),
          { name: 'status', type: 'int' },
          { name: 'duration_ms', type: 'int', unsigned: true },
          { name: 'record_count', type: 'int', unsigned: true, default: '0' },
          text('request_id', 64, true),
          { name: 'snapshot', type: 'json', isNullable: true },
        ],
      ],
      [
        'sys_login_log',
        [
          text('event', 32),
          text('username', 64, true),
          bool('success'),
          text('reason', 40, true),
          text('ip', 64, true),
          text('user_agent', 500, true),
          {
            name: 'session_hash',
            type: 'char',
            length: '64',
            isNullable: true,
          },
        ],
      ],
    ];
    for (const [name, columns, unique] of definitions) {
      if (await runner.hasTable(name))
        throw new Error(`${name} 已存在，请核对未完成的迁移，拒绝覆盖`);
      await runner.createTable(
        new Table({
          name,
          columns: [
            ...source.columns
              .filter((column) => names.has(column.name))
              .map((column) => column.clone()),
            ...columns,
          ],
          indices: [
            { name: `ix_${name}_tenant`, columnNames: ['tenant_id'] },
            { name: `ix_${name}_org`, columnNames: ['org_id'] },
            ...(unique
              ? [
                  {
                    name: `uq_${name}_business`,
                    columnNames: ['tenant_id', ...unique, 'active_guard'],
                    isUnique: true,
                  },
                ]
              : [
                  {
                    name: `ix_${name}_created`,
                    columnNames: ['tenant_id', 'created_at'],
                  },
                ]),
          ],
        }),
      );
    }
  }
  async down(): Promise<void> {
    throw new Error('日志与字典不自动删除，回退需要人工备份确认');
  }
}
