import { describe, expect, it } from 'vitest';
import {
  attachDisplay,
  DISPLAY_FIELDS,
  type CrudDisplaySource,
} from './crud-display.js';

const source: CrudDisplaySource = {
  users: (_t, ids) =>
    Promise.resolve(
      new Map(ids.filter((id) => id === '7').map((id) => [id, '张三'])),
    ),
  orgs: (_t, ids) =>
    Promise.resolve(
      new Map(ids.filter((id) => id === '2').map((id) => [id, '一部'])),
    ),
};

describe('attachDisplay', () => {
  it('资源声明的编号字段和框架字段一起补显示名', async () => {
    const rows: Record<string, unknown>[] = [
      { createdBy: '7', defaultOrgId: '2', supervisorId: '9' },
    ];
    await attachDisplay(source, '1', rows, {
      ...DISPLAY_FIELDS,
      defaultOrgId: 'orgs',
      supervisorId: 'users',
    });
    // 查不到的编号（9）不返回名称，前端和导出继续显示编号
    expect(rows[0]._display).toEqual({
      createdBy: '张三',
      defaultOrgId: '一部',
    });
  });

  it('不声明时只处理框架字段', async () => {
    const rows: Record<string, unknown>[] = [{ defaultOrgId: '2' }];
    await attachDisplay(source, '1', rows);
    expect(rows[0]._display).toBeUndefined();
  });
});
