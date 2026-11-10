/* eslint-disable typescript/no-misused-spread -- 规格和 DTO 在这些测试中均为 JSON 字面量，不含类实例方法。 */
import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import {
  validateSpec,
  migrateLegacyConfig,
  specToConfig,
  type ModuleSpec,
} from './module-spec.js';
import { renderServer } from './render-server.js';
import { specSchema } from './spec-schema.js';
import { tableDefinition } from './table-definition.js';
import { loadGenerated } from '../../../test/support/generated-code.js';
import { CRUD_RESOURCE } from '../../core/crud/base.controller.js';
import { buildCrudSchema } from '../../core/crud/crud-schema.js';
import type { CrudResourceMeta } from '../../core/crud/crud.types.js';

const spec = (): ModuleSpec => ({
  version: 1,
  moduleName: 'crm',
  businessName: 'customer',
  tableName: 'crm_customer',
  title: '客户',
  permissionPrefix: 'crm:customer',
  template: 'single',
  fields: [
    {
      property: 'name',
      column: 'name',
      label: '名称',
      type: 'string',
      length: 50,
      unique: true,
    },
    {
      property: 'budget',
      column: 'budget',
      label: '预算',
      type: 'money',
      precision: 12,
      scale: 2,
      defaultValue: '0.00',
    },
    {
      property: 'enabled',
      column: 'enabled',
      label: '启用',
      type: 'boolean',
      defaultValue: true,
    },
    {
      property: 'birthday',
      column: 'birthday',
      label: '日期',
      type: 'date',
      nullable: true,
    },
    {
      property: 'note',
      column: 'note',
      label: '备注',
      type: 'text',
      nullable: true,
    },
  ],
});

describe('ModuleSpec v1', () => {
  it('日期时间默认值严格校验日历和时分秒，不接受自动滚动到下月', () => {
    const defaults = (value: string) => ({
      ...spec(),
      fields: [
        {
          property: 'occurredAt',
          column: 'occurred_at',
          label: '时间',
          type: 'datetime',
          defaultValue: value,
        },
      ],
    });
    expect(
      validateSpec(defaults('2026-02-30 10:00:00')).map((e) => e.path),
    ).toContain('fields[0].defaultValue');
    expect(
      validateSpec(defaults('2026-02-29 10:00:00')).length,
    ).toBeGreaterThan(0);
    expect(validateSpec(defaults('2024-02-29 10:00:00'))).toEqual([]);
    expect(
      validateSpec(defaults('2026-11-10 24:00:00')).length,
    ).toBeGreaterThan(0);
  });
  it('旧子表的归属外键不进入新字段列表；缺少字典编码的旧字典字段回退为文本', () => {
    const old = specToConfig(spec());
    old.template = 'master-detail';
    old.children = [
      {
        table: 'crm_customer_contact',
        label: '联系人',
        foreignKey: 'customerId',
        fields: [
          {
            name: 'customerId',
            column: 'customer_id',
            label: '客户',
            type: 'int',
          },
          { name: 'kind', column: 'kind', label: '分类', type: 'dictionary' },
        ],
      },
    ];
    const migrated = migrateLegacyConfig(old);
    expect(migrated.children![0].fields.map((field) => field.property)).toEqual(
      ['kind'],
    );
    expect(migrated.children![0].fields[0].type).toBe('string');
    expect(validateSpec(migrated)).toEqual([]);
  });
  it('严格拒绝未知字段、显示项、错误版本及错误对象结构，并返回路径', () => {
    expect(validateSpec(spec())).toEqual([]);
    expect(validateSpec(null)[0].path).toBe('');
    expect(
      validateSpec({
        ...spec(),
        version: 2,
        listed: true,
        fields: [{ ...spec().fields[0], widget: 'input', length: -1 }],
      }).map((e) => e.path),
    ).toEqual(
      expect.arrayContaining([
        'version',
        'listed',
        'fields[0].widget',
        'fields[0].length',
      ]),
    );
    expect(validateSpec({ ...spec(), fields: [null] })[0].path).toBe(
      'fields[0]',
    );
  });
  it.each([
    { property: 'tenantId' },
    { column: 'created_at' },
    { property: 'constructor' },
    { type: 'sql' },
    { defaultValue: '1); DROP TABLE x' },
    { precision: 1, scale: 8 },
    { fieldPerm: { default: 'admin' } },
  ])('拦截保留名、非法类型、SQL 默认值和权限：%j', (change) => {
    const s = spec();
    s.fields[1] = { ...s.fields[1], ...change } as ModuleSpec['fields'][number];
    expect(validateSpec(s).length).toBeGreaterThan(0);
  });
  it('拒绝重复列、子表路径冲突和外键重复声明', () => {
    const s = spec();
    s.fields.push({ ...s.fields[0], property: 'other' });
    expect(validateSpec(s).some((e) => e.path.endsWith('.column'))).toBe(true);
    const child = {
      tableName: 'crm_customer',
      title: '明细',
      foreignKey: 'customerId',
      fields: [
        {
          property: 'customerId',
          column: 'customer_id',
          label: '客户',
          type: 'reference' as const,
        },
      ],
    };
    expect(
      validateSpec({
        ...spec(),
        template: 'masterDetail',
        children: [child],
      }).map((e) => e.path),
    ).toEqual(
      expect.arrayContaining([
        'children[0].tableName',
        'children[0].fields[0].property',
      ]),
    );
  });
  it('旧配置只转换数据结构，丢弃显示配置', () => {
    const old = specToConfig(spec());
    old.fields[0].list = false;
    old.fields[0].query = null;
    old.fields[0].component = 'radio';
    old.options!.formMode = 'dialog';
    const migrated = migrateLegacyConfig(old);
    expect(validateSpec(migrated)).toEqual([]);
    expect(migrated.fields[0]).not.toHaveProperty('list');
    expect(migrated.options).not.toHaveProperty('formMode');
    expect(specToConfig(migrated).fields[0].list).toBe(true);
  });
  it('页面描述与真实生成实体和控制器完全一致，不累积临时元数据', () => {
    for (const template of ['single', 'tree', 'masterDetail'] as const) {
      const s = spec();
      s.template = template;
      if (template === 'tree') {
        s.tree = { parentField: 'parentId', nameField: 'name' };
        s.fields.push({
          property: 'parentId',
          column: 'parent_id',
          label: '上级',
          type: 'reference',
          nullable: true,
        });
      }
      if (template === 'masterDetail')
        s.children = [
          {
            tableName: 'crm_customer_contact',
            title: '联系人',
            foreignKey: 'customerId',
            fields: [
              {
                property: 'phone',
                column: 'phone',
                label: '电话',
                type: 'string',
              },
            ],
          },
        ];
      const files = renderServer(specToConfig(s), 1800000000000);
      const modules = loadGenerated([
        ...files.filter((f) => f.path.endsWith('.entity.ts')),
        ...files.filter((f) => f.path.endsWith('.controller.ts')),
      ]);
      const controller = [...modules.values()].find(
        (m) => m.CustomerController,
      )!.CustomerController as Function;
      const meta = (
        Reflect.getMetadata(CRUD_RESOURCE, controller) as {
          meta: CrudResourceMeta;
        }
      ).meta;
      const size = getMetadataArgsStorage().columns.length;
      expect(JSON.parse(JSON.stringify(specSchema(s)))).toEqual(
        JSON.parse(JSON.stringify(buildCrudSchema(meta))),
      );
      expect(getMetadataArgsStorage().columns).toHaveLength(size);
    }
  });
  it('默认值、注释、精度都进入迁移和实体，SQL 注释无法逃逸', () => {
    const s = spec();
    s.fields[0].comment = "客户'); DROP TABLE x; --";
    const files = renderServer(specToConfig(s), 1800000000000);
    expect(files.find((f) => f.path.endsWith('.entity.ts'))!.content).toContain(
      'precision: 12, scale: 2',
    );
    expect(
      files.find((f) => f.path.includes('migrations/'))!.content,
    ).toContain('"default": "1"');
    const definition = tableDefinition(specToConfig(s));
    expect(
      definition.columns!.find((column) => column.name === 'name')!.comment,
    ).toBe(s.fields[0].comment);
    expect(
      definition.columns!.find((column) => column.name === 'budget'),
    ).toMatchObject({
      type: 'decimal',
      precision: 12,
      scale: 2,
      default: "'0.00'",
    });
  });
});
