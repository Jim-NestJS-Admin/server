import type { CrudResourceMeta } from '../crud/crud.types.js';
import { mergeView, validatePageConfig } from './page-config.rules.js';

const meta = {
  readable: ['id', 'name', 'phone', 'cost', 'status'],
  addable: ['name', 'phone', 'cost', 'status'],
  updatable: ['name', 'phone', 'cost', 'status'],
  keyWords: ['name', 'phone'],
  fieldEq: ['status', 'phone'],
  sortable: ['name', 'phone', 'id'],
  defaultSort: [{ field: 'id', order: 'desc' }],
  maxSize: 100,
  systemColumns: { createdAt: true },
} as unknown as CrudResourceMeta;

describe('在线页面配置规则（T23）', () => {
  it('保存校验：不能新增后端没有的字段、不能扩大搜索排序白名单', () => {
    const errs = validatePageConfig(meta, {
      list: {
        columns: [{ field: 'secret' }, { field: 'name', width: 10 }],
        keyWords: ['status'],
        defaultSort: [{ field: 'cost', order: 'asc' }],
        pageSize: 500,
      },
      form: { items: [{ field: 'id' }, { field: 'name', span: 6 }] },
    }).map((e) => e.field);
    expect(errs).toEqual([
      'list.columns[0].field',
      'list.columns[1].width',
      'list.keyWords[0]',
      'list.defaultSort[0]',
      'list.pageSize',
      'form.items[0].field',
      'form.items[1].span',
    ]);
    expect(
      validatePageConfig(meta, {
        list: { columns: [{ field: 'name', width: 200, fixed: 'left' }] },
      }),
    ).toEqual([]);
  });

  it('合并：管理员顺序 + 用户列设置；隐藏字段去掉，脱敏字段不能搜索筛选排序；没有写权限表单只读', () => {
    const state = (f: string) =>
      ({ cost: 'hidden', phone: 'masked' })[f] ?? 'editable';
    const v = mergeView(
      meta,
      {
        list: {
          columns: [{ field: 'status', width: 80 }, { field: 'cost' }],
          defaultSort: [{ field: 'phone', order: 'asc' }],
        },
        form: { mode: 'drawer' },
      },
      { columns: [{ field: 'name', hidden: true }, { field: 'gone' }] },
      state,
      false,
    );
    // 管理员 / 用户指定的在前，其余按代码默认：业务字段在前，系统字段（编号）在后且默认隐藏
    expect(v.list.columns.map((c) => c.field)).toEqual([
      'name',
      'status',
      'phone',
      'id',
    ]);
    expect(v.list.columns.find((c) => c.field === 'id')).toMatchObject({
      hidden: true,
    });
    expect(v.list.columns.find((c) => c.field === 'name')).toMatchObject({
      hidden: true,
    });
    expect(v.list.columns.find((c) => c.field === 'status')).toMatchObject({
      width: 80,
    });
    expect(v.list.keyWords).toEqual(['name']);
    expect(v.list.filterable).toEqual(['status']);
    expect(v.list.defaultSort).toEqual([]);
    expect(v.form).toMatchObject({ mode: 'drawer', readonly: true });
    expect(v.form.items.map((i) => i.field)).toEqual([
      'name',
      'phone',
      'status',
    ]);
  });
});
