import {
  Table,
  type MigrationInterface,
  type QueryRunner,
  type TableColumnOptions,
} from 'typeorm';
const column = (
  name: string,
  type: string,
  length?: string,
): TableColumnOptions => ({ name, type, ...(length ? { length } : {}) });
const bigint = (name: string): TableColumnOptions => ({
  name,
  type: 'bigint',
  unsigned: true,
});
function base(): TableColumnOptions[] {
  return [
    {
      ...bigint('id'),
      isPrimary: true,
      isGenerated: true,
      generationStrategy: 'increment',
    },
    { ...bigint('tenant_id'), default: '1' },
    { ...bigint('org_id'), isNullable: true },
    { ...bigint('created_by'), isNullable: true },
    { ...bigint('updated_by'), isNullable: true },
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
export class CodeRules1794528000000 implements MigrationInterface {
  async up(r: QueryRunner) {
    const specs: {
      name: string;
      columns: TableColumnOptions[];
      unique: string[];
      index: string;
    }[] = [
      {
        name: 'sys_code_rule',
        index: 'uk_code_rule_code',
        unique: ['tenant_id', 'code', 'active_guard'],
        columns: [
          column('code', 'varchar', '64'),
          column('name', 'varchar', '100'),
          { ...column('description', 'varchar', '500'), default: "''" },
          column('timezone', 'varchar', '64'),
          column('reset_period', 'varchar', '8'),
          column('segments', 'json'),
          bigint('start'),
          column('status', 'varchar', '8'),
          { name: 'revision', type: 'int', unsigned: true, default: '1' },
          {
            name: 'first_bound_at',
            type: 'datetime',
            precision: 3,
            isNullable: true,
          },
          {
            ...column('first_bound_usage_key', 'varchar', '64'),
            isNullable: true,
          },
        ],
      },
      {
        name: 'sys_code_rule_version',
        index: 'uk_code_rule_version',
        unique: ['tenant_id', 'rule_id', 'revision'],
        columns: [
          bigint('rule_id'),
          { name: 'revision', type: 'int', unsigned: true },
          column('snapshot', 'json'),
        ],
      },
      {
        name: 'sys_code_binding',
        index: 'uk_code_binding_usage',
        unique: ['tenant_id', 'usage_key', 'active_guard'],
        columns: [column('usage_key', 'varchar', '64'), bigint('rule_id')],
      },
      {
        name: 'sys_code_sequence',
        index: 'uk_code_sequence',
        unique: ['tenant_id', 'rule_id', 'period_key'],
        columns: [
          bigint('rule_id'),
          column('period_key', 'varchar', '10'),
          bigint('current'),
          { ...column('last_code', 'varchar', '64'), isNullable: true },
        ],
      },
      {
        name: 'sys_code_allocation',
        index: 'uk_code_allocation',
        unique: ['tenant_id', 'usage_key', 'code'],
        columns: [
          column('usage_key', 'varchar', '64'),
          bigint('rule_id'),
          { name: 'rule_revision', type: 'int', unsigned: true },
          { ...column('code', 'varchar', '64'), collation: 'utf8mb4_bin' },
          bigint('sequence_value'),
          column('period_key', 'varchar', '10'),
        ],
      },
    ];
    for (const s of specs)
      await r.createTable(
        new Table({
          name: s.name,
          columns: [...base(), ...s.columns],
          indices: [
            { name: s.index, columnNames: s.unique, isUnique: true },
            ...(s.name === 'sys_code_binding'
              ? [
                  {
                    name: 'uk_code_binding_rule',
                    columnNames: ['tenant_id', 'rule_id', 'active_guard'],
                    isUnique: true,
                  },
                ]
              : []),
          ],
        }),
        true,
      );
  }
  async down(r: QueryRunner) {
    for (const name of [
      'sys_code_allocation',
      'sys_code_sequence',
      'sys_code_binding',
      'sys_code_rule_version',
      'sys_code_rule',
    ])
      await r.dropTable(name, true);
  }
}
