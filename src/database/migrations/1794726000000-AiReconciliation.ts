import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';
import { foundationBaseColumns } from './1794722400000-AiFoundation.js';
export class AiReconciliation1794726000000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.createTable(
      new Table({
        name: 'ai_reconciliation',
        columns: [
          ...foundationBaseColumns(),
          { name: 'task_id', type: 'bigint', unsigned: true },
          { name: 'charged', type: 'tinyint' },
          { name: 'input_tokens', type: 'int', unsigned: true },
          { name: 'output_tokens', type: 'int', unsigned: true },
          { name: 'evidence', type: 'varchar', length: '200' },
        ],
        indices: [
          { name: 'idx_ai_reconciliation_tenant', columnNames: ['tenant_id'] },
          { name: 'idx_ai_reconciliation_org', columnNames: ['org_id'] },
          {
            name: 'uk_ai_reconciliation_task',
            columnNames: ['tenant_id', 'task_id', 'active_guard'],
            isUnique: true,
          },
        ],
      }),
      true,
    );
  }
  async down() {
    throw new Error('核对记录禁止自动删除，需先备份并核对费用');
  }
}
