import {
  Table,
  type MigrationInterface,
  type QueryRunner,
  type TableColumnOptions,
} from 'typeorm';
const column = (
  name: string,
  type: string,
  extra: Partial<TableColumnOptions> = {},
): TableColumnOptions => ({ name, type, ...extra });
const text = (name: string, length: number) =>
  column(name, 'varchar', { length: String(length) });
const integer = (name: string, defaultValue = '0') =>
  column(name, 'int', { unsigned: true, default: defaultValue });
const big = (name: string) => column(name, 'bigint', { unsigned: true });
export const foundationBaseColumns = (): TableColumnOptions[] => [
  {
    ...big('id'),
    isPrimary: true,
    isGenerated: true,
    generationStrategy: 'increment',
  },
  { ...big('tenant_id'), default: '1' },
  ...['org_id', 'created_by', 'updated_by'].map((name) => ({
    ...big(name),
    isNullable: true,
  })),
  column('created_at', 'datetime', {
    precision: 3,
    default: 'CURRENT_TIMESTAMP(3)',
  }),
  column('updated_at', 'datetime', {
    precision: 3,
    default: 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  }),
  integer('version', '1'),
  column('deleted_at', 'datetime', { precision: 3, isNullable: true }),
  column('delete_batch', 'char', { length: '36', isNullable: true }),
  column('active_guard', 'tinyint', {
    isNullable: true,
    generatedType: 'STORED',
    asExpression: 'IF(`deleted_at` IS NULL, 1, NULL)',
  }),
];
export class AiFoundation1794722400000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    const definitions: [string, TableColumnOptions[], string[]][] = [
      [
        'ai_setting',
        [
          { ...text('code', 16), default: "'default'" },
          column('enabled', 'tinyint', { default: '0' }),
          text('model', 150),
          integer('max_output_tokens'),
          column('key_cipher', 'text', { isNullable: true }),
        ],
        ['code'],
      ],
      [
        'ai_template',
        [text('code', 20), integer('revision'), column('content', 'text')],
        ['code', 'revision'],
      ],
      [
        'ai_monthly_usage',
        [
          column('month', 'char', { length: '7' }),
          { ...big('used_tokens'), default: '0' },
          { ...big('reserved_tokens'), default: '0' },
        ],
        ['month'],
      ],
      [
        'ai_task',
        [
          big('owner_id'),
          text('feature', 20),
          text('status', 16),
          text('model', 150),
          integer('template_revision'),
          column('month', 'char', { length: '7' }),
          big('reserved_tokens'),
          integer('input_tokens'),
          integer('output_tokens'),
          integer('duration_ms'),
          { ...text('error', 100), default: "''" },
          integer('max_output_tokens'),
          column('request_cipher', 'text', { isNullable: true }),
          column('result_cipher', 'mediumtext', { isNullable: true }),
          column('lease_until', 'datetime', { precision: 3, isNullable: true }),
          column('claim_token', 'char', { length: '36', isNullable: true }),
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
                    name:
                      name === 'ai_template'
                        ? 'uk_ai_template_revision'
                        : name === 'ai_setting'
                          ? 'uk_ai_setting_code'
                          : 'uk_ai_monthly_usage',
                    columnNames: ['tenant_id', ...unique, 'active_guard'],
                    isUnique: true,
                  },
                ]
              : [
                  {
                    name: 'idx_ai_task_queue',
                    columnNames: ['tenant_id', 'status', 'created_at'],
                  },
                ]),
          ],
        }),
        true,
      );
    for (const [code, content] of [
      [
        'generate',
        '请根据以下大纲生成内容初稿，仅返回正文，供人工审核。要求：{{instruction}}\n大纲：{{text}}',
      ],
      [
        'rewrite',
        '请改写以下内容，仅返回改写后的正文，供人工审核。要求：{{instruction}}\n原文：{{text}}',
      ],
      [
        'translate',
        '请将以下内容翻译为{{language}}，保留原意和格式，仅返回译文，供人工校对。术语/要求：{{instruction}}\n原文：{{text}}',
      ],
    ])
      await runner.query(
        'INSERT INTO ai_template (tenant_id,code,revision,content,version) SELECT 0,?,1,?,1 WHERE NOT EXISTS (SELECT 1 FROM ai_template WHERE tenant_id=0 AND code=? AND revision=1 AND deleted_at IS NULL)',
        [code, content, code],
      );
  }
  async down(_runner: QueryRunner) {
    throw new Error(
      'AI记录含费用与预占信息，不允许自动删除；回滚需先核对并备份',
    );
  }
}
