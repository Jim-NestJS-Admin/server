import {
  Table,
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';
import { baseColumns } from './1794628800000-WorkflowRuntime.js';

export class WorkflowApplication1814906215524 implements MigrationInterface {
  async up(runner: QueryRunner) {
    if (!(await runner.hasColumn('wf_definition', 'category')))
      await runner.addColumn(
        'wf_definition',
        new TableColumn({
          name: 'category',
          type: 'varchar',
          length: '50',
          default: "''",
        }),
      );
    await runner.createTable(
      new Table({
        name: 'wf_application_draft',
        columns: [
          ...baseColumns(),
          { name: 'definition_id', type: 'bigint', unsigned: true },
          { name: 'name', type: 'varchar', length: '100' },
          { name: 'values', type: 'json' },
          { name: 'selections', type: 'json' },
          {
            name: 'instance_id',
            type: 'bigint',
            unsigned: true,
            isNullable: true,
          },
        ],
        indices: [
          {
            name: 'idx_wf_application_draft_owner',
            columnNames: ['tenant_id', 'created_by', 'org_id', 'instance_id'],
          },
        ],
      }),
      true,
    );
  }

  async down(runner: QueryRunner) {
    await runner.dropTable('wf_application_draft', true);
    if (await runner.hasColumn('wf_definition', 'category'))
      await runner.dropColumn('wf_definition', 'category');
  }
}
