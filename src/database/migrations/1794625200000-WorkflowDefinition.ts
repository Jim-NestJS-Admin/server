import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';

/** 仅新增定义快照；实例/待办/发件箱由T38迁移管理。 */
export class WorkflowDefinition1794625200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'wf_definition',
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
          {
            name: 'description',
            type: 'varchar',
            length: '500',
            default: "''",
          },
          { name: 'revision', type: 'int', unsigned: true },
          { name: 'form_definition_id', type: 'bigint', unsigned: true },
          { name: 'designer', type: 'json' },
          { name: 'status', type: 'varchar', length: '16', default: "'draft'" },
          { name: 'bpmn', type: 'longtext' },
          { name: 'digest', type: 'char', length: '64' },
          {
            name: 'compiler_version',
            type: 'int',
            unsigned: true,
            default: '1',
          },
          {
            name: 'published_at',
            type: 'datetime',
            precision: 3,
            isNullable: true,
          },
          {
            name: 'published_by',
            type: 'bigint',
            unsigned: true,
            isNullable: true,
          },
        ],
        indices: [
          { name: 'idx_wf_definition_tenant', columnNames: ['tenant_id'] },
          { name: 'idx_wf_definition_org', columnNames: ['org_id'] },
          {
            name: 'uk_wf_definition_revision',
            columnNames: ['tenant_id', 'code', 'revision', 'active_guard'],
            isUnique: true,
          },
        ],
      }),
      true,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('wf_definition', true);
  }
}
