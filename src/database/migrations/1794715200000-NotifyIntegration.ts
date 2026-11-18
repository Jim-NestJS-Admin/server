import {
  Table,
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
  type TableColumnOptions,
  type TableIndexOptions,
} from 'typeorm';

const id = (name: string, nullable = false): TableColumnOptions => ({
  name,
  type: 'bigint',
  unsigned: true,
  isNullable: nullable,
});
const text = (name: string, length: number): TableColumnOptions => ({
  name,
  type: 'varchar',
  length: String(length),
});
const date = (name: string, nullable = false): TableColumnOptions => ({
  name,
  type: 'datetime',
  precision: 3,
  isNullable: nullable,
});
const integer = (name: string): TableColumnOptions => ({
  name,
  type: 'int',
  unsigned: true,
  default: '0',
});
const unique = (name: string, fields: string[]): TableIndexOptions => ({
  name,
  columnNames: ['tenant_id', ...fields, 'active_guard'],
  isUnique: true,
});
function base(): TableColumnOptions[] {
  return [
    {
      ...id('id'),
      isPrimary: true,
      isGenerated: true,
      generationStrategy: 'increment',
    },
    { ...id('tenant_id'), default: '1' },
    id('org_id', true),
    id('created_by', true),
    id('updated_by', true),
    { ...date('created_at'), default: 'CURRENT_TIMESTAMP(3)' },
    {
      ...date('updated_at'),
      default: 'CURRENT_TIMESTAMP(3)',
      onUpdate: 'CURRENT_TIMESTAMP(3)',
    },
    { ...integer('version'), default: '1' },
    date('deleted_at', true),
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

/** 只创建结构，启用和实际同步由部署管理员明确配置后触发。 */
export class NotifyIntegration1794715200000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    for (const table of ['sys_user', 'sys_org'])
      await runner.addColumn(
        table,
        new TableColumn({
          name: 'integration_source',
          type: 'varchar',
          length: '200',
          isNullable: true,
        }),
      );
    const definitions: {
      name: string;
      columns: TableColumnOptions[];
      indices?: TableIndexOptions[];
    }[] = [
      {
        name: 'sys_integration_card',
        columns: [
          text('event_key', 120),
          id('app_id'),
          id('task_id'),
          integer('task_version'),
          id('recipient_id'),
          text('external_id', 100),
          { name: 'response_cipher', type: 'text', isNullable: true },
          { name: 'updated', type: 'tinyint', default: '0' },
        ],
        indices: [unique('uk_integration_card_event', ['event_key'])],
      },
      {
        name: 'notify_message',
        columns: [
          text('event_key', 120),
          id('recipient_id'),
          text('event', 32),
          text('title', 100),
          id('instance_id'),
          id('task_id', true),
          date('read_at', true),
        ],
        indices: [
          unique('uk_notify_message_event', ['event_key']),
          {
            name: 'idx_notify_message_recipient',
            columnNames: ['tenant_id', 'recipient_id', 'read_at'],
          },
        ],
      },
      {
        name: 'notify_delivery',
        columns: [
          id('message_id'),
          text('channel', 16),
          { ...text('status', 16), default: "'pending'" },
          integer('attempts'),
          date('next_attempt_at'),
          { name: 'claim_token', type: 'char', length: '36', isNullable: true },
          date('claimed_until', true),
          { ...text('last_error', 200), default: "''" },
          { ...text('external_id', 200), isNullable: true },
        ],
        indices: [
          unique('uk_notify_delivery_channel', ['message_id', 'channel']),
          {
            name: 'idx_notify_delivery_due',
            columnNames: ['tenant_id', 'status', 'next_attempt_at'],
          },
        ],
      },
      {
        name: 'notify_receipt',
        columns: [
          text('event_key', 120),
          text('business_type', 64),
          text('business_id', 64),
        ],
        indices: [unique('uk_notify_receipt_event', ['event_key'])],
      },
      {
        name: 'sys_integration_app',
        columns: [
          text('platform', 16),
          text('corp_id', 100),
          text('agent_id', 32),
          id('mount_org_id'),
          id('default_role_id', true),
          { name: 'enabled', type: 'tinyint', default: '0' },
          text('admin_url', 500),
          ...['secret_cipher', 'token_cipher', 'aes_cipher'].map((name) => ({
            name,
            type: 'text',
          })),
        ],
        indices: [unique('uk_integration_app_platform', ['platform'])],
      },
      {
        name: 'sys_user_social',
        columns: [
          id('user_id'),
          text('platform', 16),
          text('corp_id', 100),
          text('external_id', 100),
        ],
        indices: [
          unique('uk_user_social_external', ['corp_id', 'external_id']),
        ],
      },
      {
        name: 'sys_org_social',
        columns: [
          id('organization_id'),
          text('corp_id', 100),
          text('external_id', 32),
        ],
        indices: [unique('uk_org_social_external', ['corp_id', 'external_id'])],
      },
      {
        name: 'sys_integration_inbox',
        columns: [
          text('event_key', 64),
          id('app_id'),
          { name: 'payload_cipher', type: 'text' },
          text('status', 16),
          integer('attempts'),
          date('next_attempt_at'),
        ],
        indices: [unique('uk_integration_inbox_event', ['event_key'])],
      },
      {
        name: 'sys_sync_log',
        columns: [
          id('app_id'),
          text('status', 16),
          integer('organizations'),
          integer('users'),
          text('detail', 200),
        ],
      },
    ];
    for (const table of definitions)
      await runner.createTable(
        new Table({
          name: table.name,
          columns: [...base(), ...table.columns],
          indices: [
            { name: `idx_${table.name}_tenant`, columnNames: ['tenant_id'] },
            { name: `idx_${table.name}_org`, columnNames: ['org_id'] },
            ...(table.indices ?? []),
          ],
        }),
        true,
      );
  }
  async down(runner: QueryRunner) {
    for (const name of [
      'sys_integration_card',
      'sys_sync_log',
      'sys_integration_inbox',
      'sys_org_social',
      'sys_user_social',
      'sys_integration_app',
      'notify_receipt',
      'notify_delivery',
      'notify_message',
    ])
      await runner.dropTable(name, true);
    for (const table of ['sys_user', 'sys_org'])
      await runner.dropColumn(table, 'integration_source');
  }
}
