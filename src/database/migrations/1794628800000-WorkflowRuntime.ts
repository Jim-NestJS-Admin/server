import {
  Table,
  type MigrationInterface,
  type QueryRunner,
  type TableColumnOptions,
  type TableIndexOptions,
} from 'typeorm';

function baseColumns(): TableColumnOptions[] {
  return [
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
    { name: 'created_by', type: 'bigint', unsigned: true, isNullable: true },
    { name: 'updated_by', type: 'bigint', unsigned: true, isNullable: true },
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
    { name: 'deleted_at', type: 'datetime', precision: 3, isNullable: true },
    { name: 'delete_batch', type: 'char', length: '36', isNullable: true },
    {
      name: 'active_guard',
      type: 'tinyint',
      isNullable: true,
      generatedType: 'STORED',
      asExpression: 'IF(`deleted_at` IS NULL, 1, NULL)',
    },
  ];
}
const id = (name: string, isNullable = false): TableColumnOptions => ({
  name,
  type: 'bigint',
  unsigned: true,
  isNullable,
});
const text = (name: string, length: number): TableColumnOptions => ({
  name,
  type: 'varchar',
  length: String(length),
});
const integer = (name: string): TableColumnOptions => ({
  name,
  type: 'int',
  unsigned: true,
});
const json = (name: string): TableColumnOptions => ({ name, type: 'json' });
const ended: TableColumnOptions = {
  name: 'ended_at',
  type: 'datetime',
  precision: 3,
  isNullable: true,
};
const completed: TableColumnOptions = { ...ended, name: 'completed_at' };

/** 第一批运行时持久化；不创建业务提交、账号、授权、菜单或实际审批记录。 */
export class WorkflowRuntime1794628800000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const tables: {
      name: string;
      columns: TableColumnOptions[];
      indices: TableIndexOptions[];
    }[] = [
      {
        name: 'wf_instance',
        columns: [
          id('definition_id'),
          id('submission_id'),
          id('form_definition_id'),
          text('code', 64),
          text('name', 100),
          integer('revision'),
          id('applicant_id'),
          text('status', 16),
          ended,
          json('designer'),
          { name: 'bpmn', type: 'longtext' },
          { name: 'digest', type: 'char', length: '64' },
          integer('compiler_version'),
          json('actors'),
          json('engine_state'),
        ],
        indices: [
          {
            name: 'uk_wf_instance_submission',
            columnNames: ['tenant_id', 'submission_id', 'active_guard'],
            isUnique: true,
          },
        ],
      },
      {
        name: 'wf_task',
        columns: [
          id('instance_id'),
          text('node_id', 48),
          text('name', 100),
          id('assignee_id'),
          text('status', 16),
          completed,
          text('execution_id', 200),
          integer('actor_index'),
        ],
        indices: [
          {
            name: 'uk_wf_task_execution',
            columnNames: [
              'tenant_id',
              'instance_id',
              'execution_id',
              'active_guard',
            ],
            isUnique: true,
          },
          {
            name: 'idx_wf_task_inbox',
            columnNames: ['tenant_id', 'assignee_id', 'status'],
          },
        ],
      },
      {
        name: 'wf_record',
        columns: [
          id('instance_id'),
          id('task_id', true),
          text('action', 16),
          { ...text('node_id', 48), isNullable: true },
          id('actor_id', true),
          { ...text('comment', 1000), default: "''" },
        ],
        indices: [
          {
            name: 'idx_wf_record_instance',
            columnNames: ['tenant_id', 'instance_id', 'id'],
          },
        ],
      },
      {
        name: 'wf_outbox',
        columns: [
          text('event_key', 120),
          text('event', 32),
          id('instance_id'),
          id('task_id', true),
          id('recipient_id', true),
          { ...text('status', 16), default: "'pending'" },
        ],
        indices: [
          {
            name: 'uk_wf_outbox_event',
            columnNames: ['tenant_id', 'event_key', 'active_guard'],
            isUnique: true,
          },
          {
            name: 'idx_wf_outbox_pending',
            columnNames: ['tenant_id', 'status', 'created_at'],
          },
        ],
      },
    ];
    for (const table of tables)
      await runner.createTable(
        new Table({
          name: table.name,
          columns: [...baseColumns(), ...table.columns],
          indices: [
            { name: `idx_${table.name}_tenant`, columnNames: ['tenant_id'] },
            { name: `idx_${table.name}_org`, columnNames: ['org_id'] },
            ...table.indices,
          ],
        }),
        true,
      );
  }
  async down(runner: QueryRunner): Promise<void> {
    for (const name of ['wf_outbox', 'wf_record', 'wf_task', 'wf_instance'])
      await runner.dropTable(name, true);
  }
}
