import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';

/** 仅定义迁移，不在模块启动时自动执行；由 T10 迁移入口统一登记。 */
export class CreateFileAsset1793923200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'file_asset',
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
            name: 'active_guard',
            type: 'tinyint',
            isNullable: true,
            asExpression: 'IF(`deleted_at` IS NULL, 1, NULL)',
            generatedType: 'STORED',
          },
          {
            name: 'delete_batch',
            type: 'char',
            length: '36',
            isNullable: true,
          },
          { name: 'name', type: 'varchar', length: '80' },
          { name: 'mime', type: 'varchar', length: '64' },
          { name: 'bytes', type: 'int', unsigned: true },
          { name: 'object_key', type: 'varchar', length: '160' },
          { name: 'sha256', type: 'char', length: '64' },
        ],
        indices: [
          { name: 'idx_file_asset_org', columnNames: ['org_id'] },
          {
            name: 'IDX_a3d31b2addc6e59905c43d1602',
            columnNames: ['tenant_id'],
          },
          {
            name: 'idx_file_asset_tenant_created',
            columnNames: ['tenant_id', 'created_at'],
          },
        ],
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('file_asset');
  }
}
