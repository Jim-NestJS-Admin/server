import { describe, expect, it } from 'vitest';
import { validOrganizations } from './organization-policy.js';

describe('登录和角色分配共用组织有效性', () => {
  const org = (id: string, parentId: string | null = null, enabled = true) => ({
    id,
    parentId,
    enabled,
  });
  it('保留正常祖先链', () =>
    expect(
      validOrganizations([org('1'), org('2', '1')]).map((row) => row.id),
    ).toEqual(['1', '2']));
  it('停用父节点时子孙全部失效，兄弟组织不受影响', () =>
    expect(
      validOrganizations([
        org('1', null, false),
        org('2', '1'),
        org('3', '2'),
        org('4'),
      ]).map((row) => row.id),
    ).toEqual(['4']));
  it('删除的祖先、缺失的祖先及组织环均不能用于授权', () =>
    expect(
      validOrganizations([
        org('1', '9'),
        org('2', '3'),
        org('3', '2'),
        org('4', '4'),
      ]),
    ).toEqual([]));
});
