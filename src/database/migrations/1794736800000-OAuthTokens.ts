import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';
import { foundationBaseColumns } from './1794722400000-AiFoundation.js';
export class OAuthTokens1794736800000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.createTable(
      new Table({
        name: 'oauth_token',
        columns: [
          ...foundationBaseColumns(),
          { name: 'model', type: 'varchar', length: '32' },
          { name: 'lookup_hash', type: 'char', length: '64' },
          { name: 'client_id', type: 'varchar', length: '200' },
          {
            name: 'grant_id',
            type: 'varchar',
            length: '100',
            isNullable: true,
          },
          { name: 'value_cipher', type: 'mediumtext' },
          { name: 'expires_at', type: 'datetime', precision: 3 },
          {
            name: 'consumed_at',
            type: 'datetime',
            precision: 3,
            isNullable: true,
          },
        ],
        indices: [
          { name: 'idx_oauth_token_tenant', columnNames: ['tenant_id'] },
          { name: 'idx_oauth_token_org', columnNames: ['org_id'] },
          {
            name: 'uk_oauth_token_model',
            columnNames: ['tenant_id', 'model', 'lookup_hash', 'active_guard'],
            isUnique: true,
          },
        ],
      }),
      true,
    );
  }
  async down() {
    throw new Error('OAuth令牌状态不自动删除，先撤销并备份');
  }
}
