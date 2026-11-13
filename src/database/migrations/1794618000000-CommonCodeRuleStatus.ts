import type { MigrationInterface, QueryRunner } from 'typeorm';
/** 合并重复状态字典，只改变存储表示，不改变启停语义、不新增业务修订。 */
export class CommonCodeRuleStatus1794618000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const invalid = await runner.query(
      "SELECT id FROM sys_code_rule WHERE status NOT IN ('enabled','disabled','1','0') LIMIT 1",
    );
    const invalidHistory = await runner.query(
      "SELECT id FROM sys_code_rule_version WHERE JSON_UNQUOTE(JSON_EXTRACT(snapshot,'$.status')) NOT IN ('enabled','disabled','1','0') LIMIT 1",
    );
    if (invalid.length || invalidHistory.length)
      throw new Error('发现未知规则状态，停止迁移以免覆盖');
    const types = await runner.query(
      "SELECT id,builtin,enabled FROM sys_dict_type WHERE tenant_id=0 AND code='sys.common_status' AND deleted_at IS NULL FOR UPDATE",
    );
    let typeId = types[0]?.id;
    if (typeId && (!types[0].builtin || !types[0].enabled))
      throw new Error('通用状态字典不是启用的系统字典，停止迁移');
    if (!typeId) {
      const result = await runner.query(
        "INSERT INTO sys_dict_type (tenant_id,code,name,enabled,builtin,`rank`) VALUES (0,'sys.common_status','通用状态',1,1,0)",
      );
      typeId = result.insertId;
    }
    for (const [value, label, style, rank] of [
      ['1', '启用', 'success', 10],
      ['0', '停用', 'info', 20],
    ]) {
      const items = await runner.query(
        'SELECT id,enabled FROM sys_dict_item WHERE tenant_id=0 AND type_id=? AND value=? AND deleted_at IS NULL FOR UPDATE',
        [typeId, value],
      );
      if (items.length && !items[0].enabled)
        throw new Error('通用状态项已停用，停止迁移');
      if (!items.length)
        await runner.query(
          'INSERT INTO sys_dict_item (tenant_id,type_id,value,label,enabled,`rank`,tag_type) VALUES (0,?,?,?,?,?,?)',
          [typeId, value, label, 1, rank, style],
        );
      else
        await runner.query(
          'UPDATE sys_dict_item SET tag_type=COALESCE(tag_type,?) WHERE id=? AND tenant_id=0',
          [style, items[0].id],
        );
    }
    await runner.query(
      "UPDATE sys_code_rule SET status=CASE status WHEN 'enabled' THEN '1' ELSE '0' END,updated_at=updated_at WHERE status IN ('enabled','disabled')",
    );
    await runner.query(
      "UPDATE sys_code_rule_version SET snapshot=JSON_SET(snapshot,'$.status',IF(JSON_UNQUOTE(JSON_EXTRACT(snapshot,'$.status'))='enabled','1','0')),updated_at=updated_at WHERE JSON_UNQUOTE(JSON_EXTRACT(snapshot,'$.status')) IN ('enabled','disabled')",
    );
    await runner.query(
      "DELETE FROM sys_dict_item WHERE tenant_id=0 AND type_id IN (SELECT id FROM sys_dict_type WHERE tenant_id=0 AND code='sys.enabled_status' AND deleted_at IS NULL)",
    );
    await runner.query(
      "DELETE FROM sys_dict_type WHERE tenant_id=0 AND code='sys.enabled_status' AND deleted_at IS NULL",
    );
    await runner.query(
      'UPDATE sys_dict_type SET version=version+1,updated_at=CURRENT_TIMESTAMP(3) WHERE tenant_id=0 AND id=?',
      [typeId],
    );
  }
  async down(): Promise<void> {
    throw new Error(
      '状态字典已合并且历史表示已迁移，请使用迁移前备份制定回退方案，禁止自动还原并覆盖后续数据',
    );
  }
}
