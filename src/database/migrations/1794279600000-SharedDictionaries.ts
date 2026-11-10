import {
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

/** 将默认基础字典迁到平台，保留编号和字典项关联；不覆盖其他租户自建的同名业务字典。 */
export class SharedDictionaries1794279600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (!(await runner.hasColumn('sys_dict_type', 'builtin')))
      await runner.addColumn(
        'sys_dict_type',
        new TableColumn({ name: 'builtin', type: 'tinyint', default: 0 }),
      );
    if (!(await runner.hasColumn('sys_dict_type', 'rank')))
      await runner.addColumn(
        'sys_dict_type',
        new TableColumn({ name: 'rank', type: 'int', default: 0 }),
      );
    const reserved = (await runner.query(
      "SELECT id FROM sys_dict_type WHERE tenant_id <> 0 AND code LIKE 'sys.%' AND deleted_at IS NULL LIMIT 1",
    )) as { id: string }[];
    if (reserved.length)
      throw new Error('业务字典占用了sys.保留前缀，请先改为业务编码再执行迁移');
    for (const code of ['common_status', 'yes_no']) {
      const shared = (await runner.query(
        'SELECT id FROM sys_dict_type WHERE tenant_id = 0 AND code = ? AND deleted_at IS NULL',
        [`sys.${code}`],
      )) as { id: string }[];
      if (shared.length) {
        await runner.query(
          'UPDATE sys_dict_type SET builtin = 1 WHERE id = ? AND tenant_id = 0',
          [shared[0].id],
        );
        continue;
      }
      const rows = (await runner.query(
        'SELECT id FROM sys_dict_type WHERE tenant_id = 1 AND code = ? AND deleted_at IS NULL',
        [code],
      )) as { id: string }[];
      if (!rows.length) continue;
      await runner.query(
        'UPDATE sys_dict_item SET tenant_id = 0 WHERE type_id = ? AND tenant_id = 1',
        [rows[0].id],
      );
      await runner.query(
        'UPDATE sys_dict_type SET tenant_id = 0, builtin = 1, code = ? WHERE id = ? AND tenant_id = 1',
        [`sys.${code}`, rows[0].id],
      );
    }
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows = (await runner.query(
      'SELECT id, code FROM sys_dict_type WHERE tenant_id = 0 AND builtin = 1',
    )) as { id: string; code: string }[];
    if (
      rows.some(
        (row) => !['sys.common_status', 'sys.yes_no'].includes(row.code),
      )
    )
      throw new Error(
        '已有新增系统字典，不能自动回退，请先备份并制定数据迁移方案',
      );
    for (const row of rows) {
      const conflict = (await runner.query(
        'SELECT id FROM sys_dict_type WHERE tenant_id = 1 AND code = ? AND deleted_at IS NULL',
        [row.code.slice(4)],
      )) as { id: string }[];
      if (conflict.length)
        throw new Error('业务租户已有同编码字典，停止回退以免覆盖');
    }
    for (const row of rows) {
      await runner.query(
        'UPDATE sys_dict_item SET tenant_id = 1 WHERE type_id = ? AND tenant_id = 0',
        [row.id],
      );
      await runner.query(
        'UPDATE sys_dict_type SET tenant_id = 1, builtin = 0, code = ? WHERE id = ? AND tenant_id = 0',
        [row.code.slice(4), row.id],
      );
    }
    await runner.dropColumn('sys_dict_type', 'rank');
    await runner.dropColumn('sys_dict_type', 'builtin');
  }
}
