import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';

/** 正式提交只追加，引用固定表单版本；历史数据不改写。 */
export class FormSubmission1794621600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'form_submission',
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
          { name: 'definition_id', type: 'bigint', unsigned: true },
          { name: 'values', type: 'json' },
          { name: 'codes', type: 'json' },
          { name: 'field_titles', type: 'json' },
        ],
        indices: [
          { name: 'idx_form_submission_tenant', columnNames: ['tenant_id'] },
          { name: 'idx_form_submission_org', columnNames: ['org_id'] },
          {
            name: 'idx_form_submission_definition',
            columnNames: ['tenant_id', 'definition_id'],
          },
        ],
      }),
      true,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('form_submission', true);
  }
}
