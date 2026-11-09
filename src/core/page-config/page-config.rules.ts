import type { CrudResourceMeta } from '../crud/crud.types.js';
import {
  defaultColumnOrder,
  defaultHiddenColumn,
} from '../crud/crud-schema.js';

export interface ViewColumn {
  field: string;
  width?: number;
  hidden?: boolean;
  fixed?: 'left' | 'right';
}
export interface ViewFormItem {
  field: string;
  group?: string;
  span?: 12 | 24;
  placeholder?: string;
}
export interface PageView {
  list: {
    columns: ViewColumn[];
    keyWords: string[];
    filterable: string[];
    defaultSort: { field: string; order: 'asc' | 'desc' }[];
    pageSize: number;
    tree: boolean;
    toolbar: { key: string; hidden?: boolean }[];
  };
  form: { mode: 'dialog' | 'drawer'; items: ViewFormItem[]; readonly: boolean };
}

/** 管理员层 / 用户层的配置：全部可选（契约 page-config.md 第 2 节） */
export type PageConfig = {
  list?: Partial<Omit<PageView['list'], never>>;
  form?: Partial<Pick<PageView['form'], 'mode' | 'items'>>;
};

type FieldError = { field: string; messages: string[] };

const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown) =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** 校验管理员保存的配置：只能用后端已有的字段和白名单，不能新增字段、不能扩大搜索排序 */
export function validatePageConfig(
  meta: CrudResourceMeta,
  raw: unknown,
): FieldError[] {
  const errs: FieldError[] = [];
  const bad = (field: string, msg: string) =>
    errs.push({ field, messages: [msg] });
  if (!obj(raw)) return [{ field: 'config', messages: ['配置必须是对象'] }];
  const readable = new Set(meta.readable);
  const writable = new Set([...meta.addable, ...meta.updatable]);
  const list = raw.list;
  if (list !== undefined) {
    if (!obj(list)) bad('list', '必须是对象');
    else {
      if (list.columns !== undefined) {
        if (!Array.isArray(list.columns) || list.columns.length > 200)
          bad('list.columns', '必须是数组');
        else
          list.columns.forEach((c: unknown, i: number) => {
            const p = `list.columns[${i}]`;
            if (
              !obj(c) ||
              typeof c.field !== 'string' ||
              !readable.has(c.field)
            )
              return bad(`${p}.field`, '不是这个页面能显示的字段');
            if (
              c.width !== undefined &&
              (!Number.isInteger(c.width) ||
                (c.width as number) < 40 ||
                (c.width as number) > 800)
            )
              bad(`${p}.width`, '宽度要在 40 到 800 之间');
            if (
              c.fixed !== undefined &&
              c.fixed !== 'left' &&
              c.fixed !== 'right'
            )
              bad(`${p}.fixed`, '只能是 left 或 right');
            if (c.hidden !== undefined && typeof c.hidden !== 'boolean')
              bad(`${p}.hidden`, '必须是 true 或 false');
          });
      }
      const subset = (key: string, allowed: string[]) => {
        const v = list[key];
        if (v === undefined) return;
        if (!strList(v)) return bad(`list.${key}`, '必须是字段名数组');
        (v as string[]).forEach((f, i) => {
          if (!allowed.includes(f))
            bad(`list.${key}[${i}]`, `${f} 不在后端允许的字段里`);
        });
      };
      subset('keyWords', meta.keyWords);
      subset('filterable', meta.fieldEq);
      if (list.defaultSort !== undefined) {
        if (!Array.isArray(list.defaultSort) || list.defaultSort.length > 5)
          bad('list.defaultSort', '最多 5 个排序字段');
        else
          list.defaultSort.forEach((s: unknown, i: number) => {
            if (
              !obj(s) ||
              typeof s.field !== 'string' ||
              !meta.sortable.includes(s.field) ||
              (s.order !== 'asc' && s.order !== 'desc')
            )
              bad(
                `list.defaultSort[${i}]`,
                '只能按可排序字段，顺序是 asc 或 desc',
              );
          });
      }
      if (
        list.pageSize !== undefined &&
        (!Number.isInteger(list.pageSize) ||
          (list.pageSize as number) < 1 ||
          (list.pageSize as number) > meta.maxSize)
      )
        bad('list.pageSize', `每页条数要在 1 到 ${meta.maxSize} 之间`);
      if (list.tree !== undefined && typeof list.tree !== 'boolean')
        bad('list.tree', '必须是 true 或 false');
      if (
        list.toolbar !== undefined &&
        (!Array.isArray(list.toolbar) ||
          !list.toolbar.every((t) => obj(t) && typeof t.key === 'string'))
      )
        bad('list.toolbar', '必须是 [{ key, hidden }]');
    }
  }
  const form = raw.form;
  if (form !== undefined) {
    if (!obj(form)) bad('form', '必须是对象');
    else {
      if (
        form.mode !== undefined &&
        form.mode !== 'dialog' &&
        form.mode !== 'drawer'
      )
        bad('form.mode', '只能是 dialog 或 drawer');
      if (form.items !== undefined) {
        if (!Array.isArray(form.items) || form.items.length > 200)
          bad('form.items', '必须是数组');
        else
          form.items.forEach((it: unknown, i: number) => {
            const p = `form.items[${i}]`;
            if (
              !obj(it) ||
              typeof it.field !== 'string' ||
              !writable.has(it.field)
            )
              return bad(`${p}.field`, '不是这个表单能填的字段');
            if (it.span !== undefined && it.span !== 12 && it.span !== 24)
              bad(`${p}.span`, '只能是 12（半行）或 24（整行）');
            if (
              it.group !== undefined &&
              (typeof it.group !== 'string' || it.group.length > 30)
            )
              bad(`${p}.group`, '分组名最多 30 字');
            if (
              it.placeholder !== undefined &&
              (typeof it.placeholder !== 'string' ||
                it.placeholder.length > 100)
            )
              bad(`${p}.placeholder`, '提示最多 100 字');
          });
      }
    }
  }
  return errs;
}

/**
 * 三层合并（代码默认 → 管理员 → 用户列设置）后按字段权限裁剪（契约 page-config.md 第 4 节）。
 * 过时的设置（字段已不在、不在白名单）自动忽略；用户层只取列的显示属性。
 * fieldState(field) 是本页面下这个字段的最宽状态；canWrite 表示本次有没有新增或修改权限。
 */
export function mergeView(
  meta: CrudResourceMeta,
  admin: PageConfig | null,
  user: { columns?: ViewColumn[] } | null,
  fieldState: (field: string) => string,
  canWrite: boolean,
): PageView {
  const visible = (f: string) => fieldState(f) !== 'hidden';
  const queryable = (f: string) => {
    const s = fieldState(f);
    return s !== 'hidden' && s !== 'masked';
  };
  const readable = new Set(meta.readable);
  // 列：代码顺序为底，管理员的顺序和属性覆盖，再叠用户的
  const order = (base: string[], over?: ViewColumn[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      out.push(f);
    };
    for (const c of over ?? []) if (readable.has(c.field)) push(c.field);
    for (const f of base) push(f);
    return out;
  };
  const adminCols = new Map(
    (admin?.list?.columns ?? []).map((c) => [c.field, c]),
  );
  const userCols = new Map((user?.columns ?? []).map((c) => [c.field, c]));
  const fields = order(
    order(defaultColumnOrder(meta), admin?.list?.columns),
    user?.columns ?? admin?.list?.columns,
  );
  // 只带设置过的属性，没设置的（undefined）不能盖掉代码默认
  const pick = (c?: ViewColumn) =>
    c
      ? Object.fromEntries(
          Object.entries({
            width: c.width,
            hidden: c.hidden,
            fixed: c.fixed,
          }).filter(([, v]) => v !== undefined),
        )
      : {};
  const columns: ViewColumn[] = fields.filter(visible).map((field) => {
    const merged = {
      // 代码默认：系统字段（编号、版本号等）默认隐藏，管理员和用户的设置覆盖它
      ...(defaultHiddenColumn(meta, field) ? { hidden: true } : {}),
      ...pick(adminCols.get(field)),
      ...pick(userCols.get(field)),
    };
    return Object.fromEntries(
      Object.entries({ field, ...merged }).filter(([, v]) => v !== undefined),
    ) as unknown as ViewColumn;
  });
  const within = (v: string[] | undefined, allowed: string[]) =>
    (v ?? allowed).filter((f) => allowed.includes(f) && queryable(f));
  const writable = new Set([...meta.addable, ...meta.updatable]);
  const items = (
    admin?.form?.items ?? meta.addable.map((field) => ({ field }))
  ).filter((i) => writable.has(i.field) && visible(i.field));
  for (const f of meta.addable)
    if (visible(f) && !items.some((i) => i.field === f))
      items.push({ field: f });
  return {
    list: {
      columns,
      keyWords: within(admin?.list?.keyWords, meta.keyWords),
      filterable: within(admin?.list?.filterable, meta.fieldEq),
      defaultSort: (admin?.list?.defaultSort ?? meta.defaultSort).filter(
        (s) => meta.sortable.includes(s.field) && queryable(s.field),
      ),
      pageSize: Math.min(admin?.list?.pageSize ?? 20, meta.maxSize),
      tree: admin?.list?.tree ?? true,
      toolbar: admin?.list?.toolbar ?? [],
    },
    form: { mode: admin?.form?.mode ?? 'dialog', items, readonly: !canWrite },
  };
}
