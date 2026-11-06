import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { CrudRuntime } from '../../../core/crud/crud.runtime.js';
import { FieldPerm } from '../../../core/field-perm/field-perm.decorator.js';
import { SystemFieldCatalog } from './system-field.catalog.js';

class Demo {
  @FieldPerm({ default: 'hidden', mask: 'phone', delegable: 'readonly' })
  phone: string;
  @FieldPerm({ configurable: false }) privateValue: string;
}
const catalog = () =>
  new SystemFieldCatalog({
    list: () => [
      {
        permPrefix: 'demo:customer',
        entity: Demo,
        fields: [
          { property: 'phone' },
          { property: 'privateValue' },
          { property: 'tenantId' },
        ],
      },
    ],
  } as unknown as CrudRuntime);
describe('字段配置代码边界', () => {
  it('系统字段、未知字段以及禁止配置字段不能进动态配置', () => {
    const c = catalog();
    for (const field of ['tenantId', 'privateValue', 'missing'])
      expect(c.find('demo:customer', field)).toBeUndefined();
    expect(c.find('other:customer', 'phone')).toBeUndefined();
  });
  it('后台最多收紧代码的可委派上限，不能放宽或给无声明字段新增委派', () => {
    const c = catalog();
    expect(() =>
      c.validate('demo:customer', 'phone', 'hidden', null, 'editable'),
    ).toThrow();
    expect(
      c.validate('demo:customer', 'phone', 'masked', null, 'masked').delegable,
    ).toBe('readonly');
  });
});
