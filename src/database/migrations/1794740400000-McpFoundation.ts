import {
  Table,
  type TableColumnOptions,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';
import { foundationBaseColumns } from './1794722400000-AiFoundation.js';
const text = (name: string, length: string): TableColumnOptions => ({
  name,
  type: 'varchar',
  length,
});
const bigint = (name: string, isNullable = false): TableColumnOptions => ({
  name,
  type: 'bigint',
  unsigned: true,
  isNullable,
});
export class McpFoundation1794740400000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    const tables: {
      name: string;
      columns: TableColumnOptions[];
      unique?: string[];
    }[] = [
      {
        name: 'mcp_setting',
        unique: [],
        columns: [
          { name: 'enabled', type: 'tinyint', default: '0' },
          { name: 'blocked', type: 'json' },
          { name: 'confirm_permissions', type: 'json' },
        ],
      },
      {
        name: 'mcp_pending_operation',
        unique: ['request_hash'],
        columns: [
          { name: 'request_hash', type: 'char', length: '64' },
          { name: 'digest', type: 'char', length: '64' },
          bigint('owner_id'),
          bigint('approver_id', true),
          text('client_id', '200'),
          text('grant_id', '100'),
          text('resource', '100'),
          text('action', '100'),
          text('permission', '150'),
          text('status', '20'),
          { name: 'payload_cipher', type: 'mediumtext' },
          { name: 'receipt', type: 'json', isNullable: true },
          { name: 'expires_at', type: 'datetime', precision: 3 },
          bigint('confirmed_by', true),
          {
            name: 'confirmed_at',
            type: 'datetime',
            precision: 3,
            isNullable: true,
          },
        ],
      },
      {
        name: 'mcp_usage',
        unique: ['month'],
        columns: [
          { name: 'month', type: 'char', length: '7' },
          { name: 'calls', type: 'int', unsigned: true, default: '0' },
        ],
      },
      {
        name: 'mcp_event',
        columns: [
          text('event', '40'),
          text('client_id', '200'),
          text('resource', '100'),
          text('action', '100'),
          bigint('operation_id', true),
        ],
      },
      {
        name: 'oauth_confirm_exempt',
        unique: ['client_id', 'org_id', 'permission'],
        columns: [
          text('client_id', '200'),
          bigint('service_user_id'),
          text('permission', '150'),
          { name: 'enabled', type: 'tinyint', default: '0' },
        ],
      },
      {
        name: 'mcp_service_approver',
        unique: ['client_id'],
        columns: [text('client_id', '200'), bigint('approver_id')],
      },
    ];
    for (const spec of tables)
      await runner.createTable(
        new Table({
          name: spec.name,
          columns: [...foundationBaseColumns(), ...spec.columns],
          indices: [
            { name: `idx_${spec.name}_tenant`, columnNames: ['tenant_id'] },
            ...(spec.unique
              ? [
                  {
                    name: `uk_${spec.name}_active`,
                    columnNames: ['tenant_id', ...spec.unique, 'active_guard'],
                    isUnique: true,
                  },
                ]
              : []),
          ],
        }),
        true,
      );
  }
  async down() {
    throw new Error('MCP确认、审计与授权记录禁止盲删除，先停用并备份');
  }
}
