import {
  Table,
  TableColumn,
  type TableColumnOptions,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';
import { foundationBaseColumns } from './1794722400000-AiFoundation.js';
export class OAuthFoundation1794729600000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    if (!(await runner.hasColumn('sys_user', 'account_type')))
      await runner.addColumn(
        'sys_user',
        new TableColumn({
          name: 'account_type',
          type: 'varchar',
          length: '16',
          default: "'human'",
        }),
      );
    const varchar = (
      name: string,
      length: number,
      isNullable = false,
    ): TableColumnOptions => ({
      name,
      type: 'varchar',
      length: String(length),
      isNullable,
    });
    const big = (name: string, isNullable = false): TableColumnOptions => ({
      name,
      type: 'bigint',
      unsigned: true,
      isNullable,
    });
    const json = (name: string, isNullable = false): TableColumnOptions => ({
      name,
      type: 'json',
      isNullable,
    });
    const definitions: [string, TableColumnOptions[], string[]][] = [
      [
        'oauth_client',
        [
          varchar('client_id', 200),
          varchar('name', 100),
          { name: 'enabled', type: 'tinyint', default: '1' },
          varchar('auth_method', 32),
          json('redirect_uris'),
          json('scopes'),
          varchar('secret_hash', 100, true),
          json('jwks', true),
          big('service_user_id', true),
          big('service_org_id', true),
          { name: 'dynamic', type: 'tinyint', default: '0' },
        ],
        ['client_id'],
      ],
      [
        'oauth_grant',
        [
          varchar('grant_id', 100),
          big('owner_id'),
          varchar('client_id', 200),
          json('scopes'),
          varchar('audience', 500),
          { name: 'active', type: 'tinyint', default: '1' },
          { name: 'client_version', type: 'int', unsigned: true },
          { name: 'user_epoch', type: 'int', unsigned: true },
          { ...varchar('kind', 16), default: "'human'" },
        ],
        ['grant_id'],
      ],
      [
        'oauth_event',
        [
          varchar('action', 40),
          varchar('client_id', 200),
          varchar('grant_id', 100, true),
        ],
        [],
      ],
    ];
    for (const [name, columns, unique] of definitions)
      await runner.createTable(
        new Table({
          name,
          columns: [...foundationBaseColumns(), ...columns],
          indices: [
            { name: `idx_${name}_tenant`, columnNames: ['tenant_id'] },
            { name: `idx_${name}_org`, columnNames: ['org_id'] },
            ...(unique.length
              ? [
                  {
                    name: `uk_${name}_id`,
                    columnNames: ['tenant_id', ...unique, 'active_guard'],
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
    throw new Error('授权与审计数据禁止盲回滚，需先撤销并备份');
  }
}
