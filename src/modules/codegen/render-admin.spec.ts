import type { CodegenConfig } from './codegen.types.js';
import { contextualSteps, manualSteps, renderAdmin } from './render-admin.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderServer } from './render-server.js';

// 和 admin 项目 codegen-templates/ 里的模板同样的占位符
const templates = {
  page: `<script setup lang="ts">
const { port, permissions } = generatedCrud({{operationPrefixJson}}, {{resourceJson}});
</script>
<template><CrudPage :page-key="{{pageKeyExpression}}" />{{ t('keep') }}</template>`,
  locale: `export default { title: {{labelJson}}, fields: {{fieldsJson}} };`,
};

const config: CodegenConfig = {
  module: 'crm',
  business: 'customer_contact',
  label: '联系人"; alert(1); "',
  permPrefix: 'crm:customer-contact',
  table: 'crm_customer_contact',
  template: 'single',
  fields: [
    { name: 'name', column: 'name', label: '姓名</script>', type: 'string' },
  ],
};

describe('前端代码渲染（T21 接 Codex 模板）', () => {
  it('已登记的模块和页面不再提示登记，无迁移不提示建表；注释不算登记', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manual-steps-'));
    await mkdir(join(root, 'src/platform'), { recursive: true });
    await writeFile(
      join(root, 'src/app.module.ts'),
      '@Module({ imports: [CustomerContactModule] }) class AppModule {}',
    );
    await writeFile(
      join(root, 'src/platform/navigation.ts'),
      'const navigationViews = new Map([["crm/customer-contact", () => import("page")]]);',
    );
    const roots = { server: root, admin: root };
    const steps = (
      await contextualSteps(config, roots, [
        'src/modules/crm/entity/customer_contact.entity.ts',
      ])
    ).join('\n');
    expect(steps).not.toMatch(
      /执行迁移|imports 里加上|navigationViews 里登记|菜单：/,
    );
    await writeFile(
      join(root, 'src/app.module.ts'),
      '// @Module({ imports: [CustomerContactModule] })',
    );
    expect(
      (
        await contextualSteps(config, roots, ['src/database/migrations/new.ts'])
      ).join('\n'),
    ).toMatch(/imports 里加上/);
    expect(
      (
        await contextualSteps(config, roots, ['src/database/migrations/new.ts'])
      ).join('\n'),
    ).toMatch(/执行迁移/);
  });
  it('仅生成被实际使用的页面，不输出无人引用的TS语言包', () => {
    expect(renderAdmin(config, templates).map((f) => f.path)).toEqual([
      'src/views/crm/customer_contact/index.vue',
    ]);
  });

  it('变量按契约生成：operationId 前缀和后端 CRUD 规则一致，文字一律 JSON 字面量', () => {
    const [page] = renderAdmin(config, templates);
    expect(page.content).toContain(
      'generatedCrud("crmCustomerContact", "crm:customer-contact")',
    );
    expect(page.content).toContain(`:page-key="'crm/customer-contact'"`);
    // Vue 自己的插值不动
    expect(page.content).toContain("{{ t('keep') }}");
    expect(manualSteps(config).join('\n')).not.toContain('语言入口');
  });

  it('模板里有不认识的变量：报错，不生成半成品', () => {
    expect(() =>
      renderAdmin(config, { ...templates, page: '{{evilJson}}' }),
    ).toThrow(/不认识的变量/);
  });

  it('菜单组件键和页面键一致；人工步骤里写明要登记的白名单', () => {
    const menu = JSON.parse(
      renderServer(config, 1).find((f) => f.path.endsWith('.menu.json'))!
        .content,
    );
    expect(menu.page.component).toBe('crm/customer-contact');
    expect(manualSteps(config).join('\n')).toContain(
      '["crm/customer-contact", () => import("@/views/crm/customer_contact/index.vue")]',
    );
  });
});
