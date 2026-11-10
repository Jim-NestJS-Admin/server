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
  it('动态字典生成实际dictCode引用，sys.前缀不会被去掉', () => {
    const files = renderServer(
      {
        ...config,
        fields: [{ ...config.fields[0], dict: 'sys.common_status' }],
      },
      1,
    );
    const entity = files.find((file) =>
      file.path.endsWith('.entity.ts'),
    )!.content;
    expect(entity).toContain('dictCode: "sys.common_status"');
    expect(entity).not.toContain('// 字典：');
  });

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

  it('主子表：子表生成实体和迁移，控制器配 children，模块登记子表实体', () => {
    const files = renderServer(
      {
        ...config,
        template: 'master-detail',
        children: [
          {
            table: 'crm_customer_contact',
            foreignKey: 'customerId',
            label: '联系人',
            fields: [
              {
                name: 'phone',
                column: 'phone',
                label: '电话',
                type: 'string',
                length: 20,
              },
            ],
          },
        ],
      },
      1800000000000,
    );
    const by = (p: string) => files.find((f) => f.path.endsWith(p))!.content;
    expect(by('entity/customer_contact.entity.ts')).toContain(
      'customerId: string',
    );
    expect(by('customer.controller.ts')).toContain('foreignKey: "customerId"');
    expect(by('customer.module.ts')).toContain('CustomerContactEntity');
    expect(
      files.some((f) =>
        f.path.endsWith('1800000000001-CreateCrmCustomerContact.ts'),
      ),
    ).toBe(true);
  });

  it('树表：父级字段生成可空 bigint 和索引，控制器配 tree 并开放 tree 接口', () => {
    const files = renderServer(
      {
        ...config,
        template: 'tree',
        tree: { parentField: 'parentId', nameField: 'name', sortField: 'sort' },
        fields: [
          ...config.fields,
          {
            name: 'parentId',
            column: 'parent_id',
            label: '上级',
            type: 'int',
            nullable: true,
          },
          { name: 'sort', column: 'sort', label: '排序', type: 'int' },
        ],
      },
      1800000000000,
    );
    const by = (p: string) => files.find((f) => f.path.endsWith(p))!.content;
    const entity = by('entity/customer.entity.ts');
    expect(entity).toContain('parentId: string | null');
    expect(entity).toContain("type: 'bigint', unsigned: true, nullable: true");
    expect(entity).toContain("component: 'tree-select'");
    const ctrl = by('customer.controller.ts');
    expect(ctrl).toContain('tree: { parentField: "parentId"');
    expect(ctrl).toContain('"tree"');
    const mig = by('CreateCrmCustomer.ts');
    expect(mig).toContain('{ columnNames: [\'tenant_id\', "parent_id"] }');
    // 树形列表用列表的权限码，不单独生成按钮
    const menu = JSON.parse(by('.menu.json'));
    expect(
      menu.buttons.map((b: { permission: string }) => b.permission),
    ).not.toContain('crm:customer:tree');
  });
});
