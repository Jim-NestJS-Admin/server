import {
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

/** 阶段一菜单原地迁到平台，保留原编号/权限码；新增固定平台页面及按钮。 */
export class PlatformMenus1794412800001 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const other = (await runner.query(
      'SELECT id FROM sys_menu WHERE tenant_id <> 1 LIMIT 1',
    )) as { id: string }[];
    if (other.length)
      throw new Error('发现非默认租户菜单，需先按备份核对，拒绝覆盖归属');
    if (await runner.hasColumn('sys_menu', 'scope'))
      throw new Error('菜单scope已存在，请核对迁移历史');
    const platform = (await runner.query(
      "SELECT id FROM sys_menu WHERE path='/platform' AND deleted_at IS NULL",
    )) as { id: string }[];
    if (platform.length) throw new Error('/platform菜单已存在，需人工核对');
    await runner.addColumn(
      'sys_menu',
      new TableColumn({
        name: 'scope',
        type: 'varchar',
        length: '16',
        default: "'tenant'",
      }),
    );
    await runner.query('UPDATE sys_menu SET tenant_id=0');
    const result = (await runner.query(
      "INSERT INTO sys_menu (tenant_id,type,path,title,icon,`rank`,scope,version) VALUES (0,'directory','/platform','平台管理','ri:global-line',0,'platform',1)",
    )) as { insertId: number | string };
    const directory = String(result.insertId);
    const names: [string, string, string][] = [
      ['租户管理', 'tenant', 'platform:tenant'],
      ['套餐管理', 'package', 'platform:package'],
    ];
    for (const [title, key, prefix] of names) {
      const page = (await runner.query(
        "INSERT INTO sys_menu (tenant_id,parent_id,type,path,title,component,permission,`rank`,scope,version) VALUES (0,?,'page',?,?,?,?,0,'platform',1)",
        [
          directory,
          `/platform/${key}`,
          title,
          `platform/${key}`,
          `${prefix}:page`,
        ],
      )) as { insertId: number | string };
      for (const [action, label] of [
        ['info', '详情'],
        ['add', '新增'],
        ['update', '修改'],
        ['delete', '删除'],
        ['export', '导出'],
      ])
        await runner.query(
          "INSERT INTO sys_menu (tenant_id,parent_id,type,path,title,permission,`rank`,scope,version) VALUES (0,?,'button','',?,?,0,'platform',1)",
          [String(page.insertId), label, `${prefix}:${action}`],
        );
    }
    const existing = (await runner.query(
      "SELECT id FROM sys_menu WHERE path='/system/menu' AND deleted_at IS NULL",
    )) as { id: string }[];
    for (const menu of existing) {
      await runner.query(
        "UPDATE sys_menu SET parent_id=?,scope='platform' WHERE id=?",
        [directory, menu.id],
      );
      await runner.query(
        "UPDATE sys_menu SET scope='platform' WHERE parent_id=?",
        [menu.id],
      );
    }
    // 全新库尚未seed时补菜单页面；原页面存在时保持原id和按钮权限码。
    if (!existing.length)
      await runner.query(
        "INSERT INTO sys_menu (tenant_id,parent_id,type,path,title,component,permission,`rank`,scope,version) VALUES (0,?,'page','/system/menu','菜单管理','system/menu','system:menu:page',30,'platform',1)",
        [directory],
      );
  }
  async down(_runner: QueryRunner): Promise<void> {
    throw new Error(
      '菜单归属/父节点迁移不自动回退；请使用迁移前备份恢复，避免覆盖迁移后新建的租户和平台菜单',
    );
  }
}
