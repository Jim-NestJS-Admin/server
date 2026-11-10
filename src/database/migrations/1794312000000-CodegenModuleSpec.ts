import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  migrateLegacyConfig,
  specToConfig,
  type ModuleSpec,
} from '../../modules/codegen/module-spec.js';
import type { CodegenConfig } from '../../modules/codegen/codegen.types.js';

/** 只转换生成器配置 JSON，不修改生成的业务表，也不执行生成代码。 */
export class CodegenModuleSpec1794312000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!(await q.hasTable('sys_codegen'))) return;
    const rows: { id: string; config: string | CodegenConfig | ModuleSpec }[] =
      await q.query('SELECT id, config FROM sys_codegen');
    for (const row of rows) {
      const config =
        typeof row.config === 'string'
          ? (JSON.parse(row.config) as CodegenConfig | ModuleSpec)
          : row.config;
      if ('version' in config && config.version === 1) continue;
      await q.query('UPDATE sys_codegen SET config = ? WHERE id = ?', [
        JSON.stringify(migrateLegacyConfig(config as CodegenConfig)),
        row.id,
      ]);
    }
  }
  async down(q: QueryRunner): Promise<void> {
    if (!(await q.hasTable('sys_codegen'))) return;
    const rows: { id: string; config: string | ModuleSpec }[] = await q.query(
      'SELECT id, config FROM sys_codegen',
    );
    for (const row of rows) {
      const config =
        typeof row.config === 'string'
          ? (JSON.parse(row.config) as ModuleSpec)
          : row.config;
      if (config.version !== 1) continue;
      // 原显示项已按设计丢弃，回退时使用按类型推导的默认显示配置。
      await q.query('UPDATE sys_codegen SET config = ? WHERE id = ?', [
        JSON.stringify(specToConfig(config)),
        row.id,
      ]);
    }
  }
}
