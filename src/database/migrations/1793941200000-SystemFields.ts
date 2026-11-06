import {
  Table,
  type MigrationInterface,
  type QueryRunner,
  type TableColumnOptions,
} from 'typeorm';
/** 字段配置属于安全配置，不和在线页面显示配置共表。 */
export class SystemFields1793941200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const base = await runner.getTable('sys_user');
    if (!base) throw new Error('请先运行T07迁移');
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
    const common: TableColumnOptions[] = [
      { name: 'resource', type: 'varchar', length: '160' },
      { name: 'field', type: 'varchar', length: '64' },
      { name: 'state', type: 'varchar', length: '16' },
      { name: 'mask', type: 'varchar', length: '16', isNullable: true },
    ];
    for (const role of [false, true]) {
      const name = role ? 'sys_role_field' : 'sys_field';
      if (await runner.hasTable(name))
        throw new Error(`${name} 已存在，拒绝覆盖`);
      const columns = base.columns
        .filter((column) => names.has(column.name))
        .map((column) => column.clone());
      const unique = [
        'tenant_id',
        ...(role ? ['role_id'] : []),
        'resource',
        'field',
        'active_guard',
      ];
      await runner.createTable(
        new Table({
          name,
          columns: [
            ...columns,
            ...common,
            ...(role
              ? [{ name: 'role_id', type: 'bigint', unsigned: true }]
              : [
                  {
                    name: 'delegable',
                    type: 'varchar',
                    length: '16',
                    isNullable: true,
                  },
                  { name: 'configurable', type: 'tinyint', default: '1' },
                  { name: 'enabled', type: 'tinyint', default: '1' },
                  {
                    name: 'source',
                    type: 'varchar',
                    length: '16',
                    default: "'admin'",
                  },
                ]),
          ],
          indices: [
            { name: `uq_${name}_active`, columnNames: unique, isUnique: true },
            { name: `ix_${name}_tenant`, columnNames: ['tenant_id'] },
          ],
        }),
      );
    }
  }
  async down(): Promise<void> {
    throw new Error('安全配置迁移不自动删除数据，请人工审查回退方案');
  }
}
