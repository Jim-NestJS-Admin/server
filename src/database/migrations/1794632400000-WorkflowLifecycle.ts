import {
  Table,
  TableColumn,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';
import type { TableColumnOptions } from 'typeorm';

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
    ...['org_id', 'created_by', 'updated_by'].map((name) => ({
      name,
      type: 'bigint',
      unsigned: true,
      isNullable: true,
    })),
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

/** 扩充运行时生命周期与节点授权；不新增实际申请/账号/菜单授权。 */
export class WorkflowLifecycle1794632400000 implements MigrationInterface {
  async up(r: QueryRunner): Promise<void> {
    await r.addColumn(
      'sys_org',
      new TableColumn({
        name: 'leader_id',
        type: 'bigint',
        unsigned: true,
        isNullable: true,
      }),
    );
    const columns: Record<string, TableColumn[]> = {
      wf_instance: [
        new TableColumn({
          name: 'origin_submission_id',
          type: 'bigint',
          unsigned: true,
          isNullable: true,
        }),
        new TableColumn({
          name: 'round',
          type: 'int',
          unsigned: true,
          default: '1',
        }),
        new TableColumn({
          name: 'business_type',
          type: 'varchar',
          length: '64',
          default: "'form/submission'",
        }),
        new TableColumn({
          name: 'business_id',
          type: 'varchar',
          length: '64',
          default: "''",
        }),
        ...[
          'viewer_ids',
          'selections',
          'applicant_roles',
          'form_changes',
          'decisions',
        ].map(
          (name) => new TableColumn({ name, type: 'json', isNullable: true }),
        ),
        new TableColumn({
          name: 'applicant_org_id',
          type: 'bigint',
          unsigned: true,
          isNullable: true,
        }),
      ],
      wf_task: [
        new TableColumn({
          name: 'round',
          type: 'int',
          unsigned: true,
          default: '1',
        }),
        new TableColumn({
          name: 'kind',
          type: 'varchar',
          length: '16',
          default: "'approve'",
        }),
        ...['viewer_ids', 'field_permissions'].map(
          (name) => new TableColumn({ name, type: 'json', isNullable: true }),
        ),
        new TableColumn({
          name: 'last_urged_at',
          type: 'datetime',
          precision: 3,
          isNullable: true,
        }),
      ],
      wf_record: [
        new TableColumn({
          name: 'target_user_id',
          type: 'bigint',
          unsigned: true,
          isNullable: true,
        }),
        new TableColumn({ name: 'form_patch', type: 'json', isNullable: true }),
        new TableColumn({
          name: 'round',
          type: 'int',
          unsigned: true,
          default: '1',
        }),
        new TableColumn({
          name: 'submission_id',
          type: 'bigint',
          unsigned: true,
          isNullable: true,
        }),
        ...['viewer_ids', 'attachment_ids'].map(
          (name) => new TableColumn({ name, type: 'json', isNullable: true }),
        ),
      ],
    };
    for (const [name, cols] of Object.entries(columns))
      await r.addColumns(name, cols);
    await r.query(
      'UPDATE wf_instance SET origin_submission_id = submission_id, business_id = CAST(submission_id AS CHAR), applicant_org_id = org_id, selections = JSON_OBJECT(), applicant_roles = JSON_ARRAY(), form_changes = JSON_OBJECT(), decisions = JSON_OBJECT()',
    );
    await r.query('UPDATE wf_task SET field_permissions = JSON_OBJECT()');
    await r.query(
      'UPDATE wf_record SET attachment_ids = JSON_ARRAY(), form_patch = JSON_OBJECT()',
    );
    const instances: {
      id: string;
      applicantId: string;
      submissionId: string;
    }[] = await r.query(
      'SELECT CAST(id AS CHAR) AS id, CAST(applicant_id AS CHAR) AS applicantId, CAST(submission_id AS CHAR) AS submissionId FROM wf_instance',
    );
    for (const instance of instances) {
      const tasks: { assigneeId: string }[] = await r.query(
        'SELECT CAST(assignee_id AS CHAR) AS assigneeId FROM wf_task WHERE instance_id = ?',
        [instance.id],
      );
      const ids = JSON.stringify([
        ...new Set([instance.applicantId, ...tasks.map((t) => t.assigneeId)]),
      ]);
      await r.query('UPDATE wf_instance SET viewer_ids = ? WHERE id = ?', [
        ids,
        instance.id,
      ]);
      await r.query(
        'UPDATE wf_task SET viewer_ids = JSON_ARRAY(CAST(assignee_id AS CHAR)) WHERE instance_id = ?',
        [instance.id],
      );
      await r.query(
        'UPDATE wf_record SET viewer_ids = ?, submission_id = ? WHERE instance_id = ?',
        [ids, instance.submissionId, instance.id],
      );
    }
    for (const [table, cols] of Object.entries(columns))
      for (const col of cols) {
        if (
          [
            'viewer_ids',
            'selections',
            'applicant_roles',
            'form_changes',
            'decisions',
            'form_patch',
            'field_permissions',
            'attachment_ids',
            'origin_submission_id',
          ].includes(col.name)
        )
          await r.changeColumn(
            table,
            col.name,
            new TableColumn({
              name: col.name,
              type: col.type,
              unsigned: col.unsigned,
              isNullable: false,
            }),
          );
      }
    await r.dropIndex('wf_instance', 'uk_wf_instance_submission');
    await r.createIndex(
      'wf_instance',
      new TableIndex({
        name: 'uk_wf_instance_submission',
        columnNames: ['tenant_id', 'origin_submission_id', 'active_guard'],
        isUnique: true,
      }),
    );
    await r.createIndex(
      'wf_instance',
      new TableIndex({
        name: 'uk_wf_instance_business',
        columnNames: [
          'tenant_id',
          'business_type',
          'business_id',
          'active_guard',
        ],
        isUnique: true,
      }),
    );
    await r.createTable(
      new Table({
        name: 'wf_timer',
        columns: [
          ...baseColumns(),
          { name: 'instance_id', type: 'bigint', unsigned: true },
          { name: 'task_id', type: 'bigint', unsigned: true },
          { name: 'due_at', type: 'datetime', precision: 3 },
          { name: 'action', type: 'varchar', length: '16' },
          {
            name: 'status',
            type: 'varchar',
            length: '16',
            default: "'pending'",
          },
          { name: 'claim_token', type: 'char', length: '36', isNullable: true },
          {
            name: 'claimed_until',
            type: 'datetime',
            precision: 3,
            isNullable: true,
          },
          { name: 'attempts', type: 'int', unsigned: true, default: '0' },
          {
            name: 'last_error',
            type: 'varchar',
            length: '200',
            isNullable: true,
          },
        ],
        indices: [
          { name: 'idx_wf_timer_tenant', columnNames: ['tenant_id'] },
          { name: 'idx_wf_timer_org', columnNames: ['org_id'] },
          {
            name: 'uk_wf_timer_task',
            columnNames: ['tenant_id', 'task_id', 'active_guard'],
            isUnique: true,
          },
          {
            name: 'idx_wf_timer_due',
            columnNames: ['tenant_id', 'status', 'due_at'],
          },
        ],
      }),
      true,
    );
  }
  async down(): Promise<void> {
    throw new Error('审批运行数据不可自动降级，请先归档并制定专用迁移');
  }
}
