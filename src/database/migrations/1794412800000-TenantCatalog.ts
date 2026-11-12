import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';

/** 平台目录表；本迁移不变更现有业务数据，也不创建默认账号或demo。 */
export class TenantCatalog1794412800000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    for (const [name, columns] of [
      [
        'sys_package',
        [
          { name: 'code', type: 'varchar', length: '32' },
          { name: 'name', type: 'varchar', length: '100' },
          { name: 'enabled', type: 'tinyint', default: '1' },
          { name: 'menu_ids', type: 'json' },
          { name: 'quotas', type: 'json' },
          { name: 'remark', type: 'varchar', length: '500', isNullable: true },
        ],
      ],
      [
        'sys_tenant',
        [
          { name: 'code', type: 'varchar', length: '32' },
          { name: 'name', type: 'varchar', length: '100' },
          { name: 'package_id', type: 'bigint', unsigned: true },
          { name: 'domains', type: 'json' },
          { name: 'enabled', type: 'tinyint', default: '1' },
          {
            name: 'expires_at',
            type: 'datetime',
            precision: 3,
            isNullable: true,
          },
          {
            name: 'contact_name',
            type: 'varchar',
            length: '50',
            isNullable: true,
          },
          {
            name: 'contact_phone',
            type: 'varchar',
            length: '30',
            isNullable: true,
          },
          { name: 'remark', type: 'varchar', length: '500', isNullable: true },
        ],
      ],
    ] as const) {
      await runner.createTable(
        new Table({
          name,
          columns: [
            {
              name: 'id',
              type: 'bigint',
              unsigned: true,
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            { name: 'tenant_id', type: 'bigint', unsigned: true, default: '1' },
            {
              name: 'org_id',
              type: 'bigint',
              unsigned: true,
              isNullable: true,
            },
            {
              name: 'created_by',
              type: 'bigint',
              unsigned: true,
              isNullable: true,
            },
            {
              name: 'updated_by',
              type: 'bigint',
              unsigned: true,
              isNullable: true,
            },
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
            {
              name: 'deleted_at',
              type: 'datetime',
              precision: 3,
              isNullable: true,
            },
            {
              name: 'delete_batch',
              type: 'char',
              length: '36',
              isNullable: true,
            },
            {
              name: 'active_guard',
              type: 'tinyint',
              isNullable: true,
              asExpression: 'IF(`deleted_at` IS NULL, 1, NULL)',
              generatedType: 'STORED',
            },
            ...columns,
          ],
          indices: [
            { name: `idx_${name}_tenant`, columnNames: ['tenant_id'] },
            { name: `idx_${name}_org`, columnNames: ['org_id'] },
            {
              name: `uk_${name}_code`,
              columnNames: ['tenant_id', 'code', 'active_guard'],
              isUnique: true,
            },
          ],
        }),
      );
    }
  }
  async down(runner: QueryRunner): Promise<void> {
    // MySQL DROP TABLE 会一并删除索引，避免QueryRunner复用时先按过期缓存删索引。
    await runner.query('DROP TABLE `sys_tenant`');
    await runner.query('DROP TABLE `sys_package`');
  }
}
