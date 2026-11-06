import type { CodegenConfig } from './codegen.types.js';
import { renderServer } from './render-server.js';

const config: CodegenConfig = {
  module: 'crm',
  business: 'customer',
  label: '客户"; process.exit(1); "',
  permPrefix: 'crm:customer',
  table: 'crm_customer',
  template: 'single',
  options: { export: true },
  fields: [
    {
      name: 'name',
      column: 'name',
      label: '名称`${x}`',
      type: 'string',
      length: 50,
      query: 'like',
    },
  ],
};

describe('后端代码渲染（T21）', () => {
  it('只生成白名单目录里的文件', () => {
    const paths = renderServer(config, 1800000000000).map((f) => f.path);
    expect(paths).toEqual([
      'src/modules/crm/entity/customer.entity.ts',
      'src/modules/crm/controller/admin/customer.controller.ts',
      'src/modules/crm/customer.module.ts',
      'src/modules/crm/customer.menu.json',
      'src/database/migrations/1800000000000-CreateCrmCustomer.ts',
    ]);
  });

  it('显示名称按字符串字面量转义，不会变成代码', () => {
    const all = renderServer(config, 1800000000000)
      .map((f) => f.content)
      .join('\n');
    expect(all).toContain(JSON.stringify('客户"; process.exit(1); "'));
    expect(all).not.toMatch(/[^\\]"; process\.exit/);
    expect(all).toContain(JSON.stringify('名称`${x}`'));
  });

  it('菜单数据带全部按钮权限码', () => {
    const menu = JSON.parse(
      renderServer(config, 1).find((f) => f.path.endsWith('.menu.json'))!
        .content,
    );
    expect(menu.page.permission).toBe('crm:customer:page');
    expect(
      menu.buttons.map((b: { permission: string }) => b.permission),
    ).toContain('crm:customer:export');
  });
});
