import {
  Table,
  TableColumn,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

/** T07多上级关系及带空组织作用范围的分配唯一约束，兼容已经初始化的本地库。 */
export class SystemRelationships1793930400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (!(await runner.hasColumn('sys_user_role', 'scope_guard'))) {
      await runner.addColumn(
        'sys_user_role',
        new TableColumn({
          name: 'scope_guard',
          type: 'bigint',
          unsigned: true,
          generatedType: 'STORED',
          asExpression: 'IFNULL(`scope_org_id`, 0)',
        }),
      );
    }
    const grants = await runner.getTable('sys_user_role');
    if (
      !grants?.indices.some((index) => index.name === 'uq_sys_user_role_scope')
    )
      await runner.createIndex(
        'sys_user_role',
        new TableIndex({
          name: 'uq_sys_user_role_scope',
          columnNames: [
            'tenant_id',
            'user_id',
            'role_id',
            'scope_guard',
            'active_guard',
          ],
          isUnique: true,
        }),
      );
    if (!(await runner.hasTable('sys_user_supervisor'))) {
      const user = await runner.getTable('sys_user');
      if (!user) throw new Error('请先运行初始系统迁移');
      const base = new Set([
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
      await runner.createTable(
        new Table({
          name: 'sys_user_supervisor',
          columns: [
            ...user.columns
              .filter((column) => base.has(column.name))
              .map((column) => column.clone()),
            { name: 'user_id', type: 'bigint', unsigned: true },
            { name: 'supervisor_id', type: 'bigint', unsigned: true },
          ],
          indices: [
            {
              name: 'ix_sys_user_supervisor_tenant',
              columnNames: ['tenant_id'],
            },
            { name: 'ix_sys_user_supervisor_org', columnNames: ['org_id'] },
            {
              name: 'uq_sys_user_supervisor_link',
              columnNames: [
                'tenant_id',
                'user_id',
                'supervisor_id',
                'active_guard',
              ],
              isUnique: true,
            },
          ],
        }),
      );
    }
  }
  async down(): Promise<void> {
    throw new Error('上下级与权限关系的回退必须人工备份确认，不自动删除');
  }
}
