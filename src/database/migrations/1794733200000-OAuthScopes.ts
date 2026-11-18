import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';
import { foundationBaseColumns } from './1794722400000-AiFoundation.js';
export class OAuthScopes1794733200000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.createTable(
      new Table({
        name: 'oauth_scope',
        columns: [
          ...foundationBaseColumns(),
          { name: 'code', type: 'varchar', length: '100' },
          { name: 'permissions', type: 'json' },
        ],
        indices: [
          { name: 'idx_oauth_scope_tenant', columnNames: ['tenant_id'] },
          { name: 'idx_oauth_scope_org', columnNames: ['org_id'] },
          {
            name: 'uk_oauth_scope_code',
            columnNames: ['tenant_id', 'code', 'active_guard'],
            isUnique: true,
          },
        ],
      }),
      true,
    );
  }
  async down() {
    throw new Error('授权范围登记需保留审计依据，不自动删除');
  }
}
