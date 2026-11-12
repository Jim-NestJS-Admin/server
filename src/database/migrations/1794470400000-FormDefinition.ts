import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';

/** 表单定义按修订追加，唯一索引同时保护租户与修订编号。 */
export class FormDefinition1794470400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'form_definition',
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
            name: 'delete_batch',
            type: 'char',
            length: '36',
            isNullable: true,
          },
          {
            name: 'active_guard',
            type: 'tinyint',
            isNullable: true,
            generatedType: 'STORED',
            asExpression: 'IF(`deleted_at` IS NULL, 1, NULL)',
          },
          { name: 'code', type: 'varchar', length: '64' },
          { name: 'name', type: 'varchar', length: '100' },
          { name: 'revision', type: 'int', unsigned: true },
          { name: 'designer', type: 'json' },
          { name: 'fields', type: 'json' },
        ],
        indices: [
          { name: 'idx_form_definition_tenant', columnNames: ['tenant_id'] },
          { name: 'idx_form_definition_org', columnNames: ['org_id'] },
          {
            name: 'uk_form_definition_revision',
            columnNames: ['tenant_id', 'code', 'revision', 'active_guard'],
            isUnique: true,
          },
        ],
      }),
      true,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('form_definition', true);
  }
}
