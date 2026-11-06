import { describe, expect, it } from 'vitest';
import { auditSnapshot } from './audit-snapshot.js';

describe('审计快照凭据清理（统一阶段执行）', () => {
  it('多层对象和数组中的凭据被隐去，保留业务内容', () => {
    expect(
      auditSnapshot({
        title: '记录',
        passwordHash: '不能保存',
        child: [{ secret: '不能保存', value: 12 }],
        authorization: '不能保存',
        cookie: '不能保存',
      }),
    ).toEqual({
      title: '记录',
      passwordHash: '[已隐去]',
      child: [{ secret: '[已隐去]', value: 12 }],
      authorization: '[已隐去]',
      cookie: '[已隐去]',
    });
  });
  it('超过最大深度时拒绝审计，从而使删除回滚', () => {
    let data: unknown = {};
    for (let i = 0; i < 22; i++) data = { child: data };
    expect(() => auditSnapshot(data)).toThrow('嵌套过深');
  });
});
