import {
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';
/** 仅扩展字典展示元数据，保留现有业务状态值及已有字典。 */
export class DictionaryTags1794614400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (!(await runner.hasColumn('sys_dict_item', 'tag_type')))
      await runner.addColumn(
        'sys_dict_item',
        new TableColumn({
          name: 'tag_type',
          type: 'varchar',
          length: '16',
          isNullable: true,
        }),
      );
    const found = await runner.query(
      "SELECT id, builtin FROM sys_dict_type WHERE tenant_id=0 AND code='sys.enabled_status' AND deleted_at IS NULL",
    );
    if (found.length && !found[0].builtin)
      throw new Error('sys.enabled_status已被非系统字典占用，停止迁移');
    let typeId = found[0]?.id;
    if (!typeId) {
      const inserted = await runner.query(
        "INSERT INTO sys_dict_type (tenant_id,code,name,enabled,builtin,`rank`) VALUES (0,'sys.enabled_status','启用停用状态',1,1,0)",
      );
      typeId = inserted.insertId;
    }
    for (const [value, label, tagType, rank] of [
      ['enabled', '启用', 'success', 10],
      ['disabled', '停用', 'info', 20],
    ]) {
      await runner.query(
        'INSERT INTO sys_dict_item (tenant_id,type_id,value,label,enabled,`rank`,tag_type) SELECT 0,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM sys_dict_item WHERE tenant_id=0 AND type_id=? AND value=? AND deleted_at IS NULL)',
        [typeId, value, label, 1, rank, tagType, typeId, value],
      );
    }
  }
  async down(runner: QueryRunner): Promise<void> {
    // 字典可能已被业务引用，回退展示列时保留状态值，避免破坏已有规则。
    if (await runner.hasColumn('sys_dict_item', 'tag_type'))
      await runner.dropColumn('sys_dict_item', 'tag_type');
  }
}
