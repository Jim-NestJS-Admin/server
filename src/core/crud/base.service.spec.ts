import { BaseService } from './base.service.js';
import type { CrudBinding } from './base.service.js';
import type { BaseEntity } from './base.entity.js';

const binding = (prefix: string, entity: Function) =>
  ({ meta: { prefix, entity } }) as unknown as CrudBinding<BaseEntity>;

describe('BaseService 绑定', () => {
  class A {}
  it('同一个资源定义可以重复绑定（同一控制器重新初始化）', () => {
    const s = new BaseService<BaseEntity>();
    const b = binding('x/a', A);
    s.bindCrud(b);
    expect(() => s.bindCrud(b)).not.toThrow();
  });

  it('同一实体的另一个资源：拒绝，原绑定不变', () => {
    const s = new BaseService<BaseEntity>();
    s.bindCrud(binding('x/a', A));
    expect(() => s.bindCrud(binding('x/b', A))).toThrow(
      /已绑定到资源 x\/a，不能再绑定 x\/b/,
    );
    expect(s.meta.prefix).toBe('x/a');
  });

  it('没绑定就使用：给出明确错误', () => {
    expect(() => new BaseService<BaseEntity>().meta).toThrow(/还没有绑定资源/);
  });
});
