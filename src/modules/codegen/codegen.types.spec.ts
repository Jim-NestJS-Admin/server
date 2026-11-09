import { mapColumnType, validateCodegenConfig } from './codegen.types.js';

const ok = {
  module: 'crm',
  business: 'customer',
  label: '客户',
  permPrefix: 'crm:customer',
  table: 'crm_customer',
  template: 'single',
  fields: [
    { name: 'name', column: 'name', label: '名称', type: 'string', length: 50 },
  ],
};

describe('代码生成配置校验（T21）', () => {
  it('合法配置通过', () => {
    expect(validateCodegenConfig(ok)).toEqual([]);
  });

  it('标识符、保留字、类型、组件都走白名单', () => {
    const errs = validateCodegenConfig({
      ...ok,
      module: '../etc',
      table: 'crm customer; DROP TABLE x',
      fields: [
        { name: 'id', column: 'id', label: 'x', type: 'string' },
        {
          name: 'evil',
          column: 'a`b',
          label: 'x',
          type: 'blob',
          component: 'iframe',
        },
      ],
    }).map((e) => e.field);
    expect(errs).toEqual(
      expect.arrayContaining([
        'module',
        'table',
        'fields[0].name',
        'fields[1].column',
        'fields[1].type',
        'fields[1].component',
      ]),
    );
  });

  it('列类型映射', () => {
    expect(mapColumnType('tinyint', 'tinyint(1)')).toBe('boolean');
    expect(mapColumnType('bigint', 'bigint unsigned')).toBe('int');
    expect(mapColumnType('decimal', 'decimal(10,2)')).toBe('decimal');
    expect(mapColumnType('varchar', 'varchar(50)')).toBe('string');
  });
});
