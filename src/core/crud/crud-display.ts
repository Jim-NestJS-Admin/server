import type { DisplayKind } from './crud-field.decorator.js';

/**
 * 列表显示名：行里的创建人、修改人、所属组织是编号，页面上要显示名称。
 * core 不认识用户表和组织表，由系统模块在启动时注册一个实现（CrudRuntime.setDisplaySource）。
 * 没注册时（例如独立测试）只返回编号，不影响数据。
 */
export interface CrudDisplaySource {
  /** 用户编号 → 显示名（姓名，没有就用账号）；查不到的编号不返回 */
  users(tenantId: string, ids: string[]): Promise<Map<string, string>>;
  /** 组织编号 → 组织名称 */
  orgs(tenantId: string, ids: string[]): Promise<Map<string, string>>;
}

/** 哪些字段按哪类名称显示 */
export const DISPLAY_FIELDS: Record<string, DisplayKind> = {
  createdBy: 'users',
  updatedBy: 'users',
  orgId: 'orgs',
};

/** 给一批行补 _display：{ 字段: 显示名 }。只处理行里实际返回了的字段 */
export async function attachDisplay(
  source: CrudDisplaySource | undefined,
  tenantId: string,
  rows: Record<string, unknown>[],
  /** 资源自己声明的编号字段（CrudField 的 display），和框架字段合并 */
  fields: Record<string, DisplayKind> = DISPLAY_FIELDS,
): Promise<void> {
  if (!source || !rows.length) return;
  const want: Record<'users' | 'orgs', Set<string>> = {
    users: new Set(),
    orgs: new Set(),
  };
  for (const r of rows)
    for (const [f, kind] of Object.entries(fields)) {
      const v = idOf(r[f]);
      if (v) want[kind].add(v);
    }
  const [users, orgs] = await Promise.all([
    want.users.size ? source.users(tenantId, [...want.users]) : new Map(),
    want.orgs.size ? source.orgs(tenantId, [...want.orgs]) : new Map(),
  ]);
  const maps = { users, orgs } as Record<'users' | 'orgs', Map<string, string>>;
  for (const r of rows) {
    const display: Record<string, string> = {};
    for (const [f, kind] of Object.entries(fields)) {
      const v = idOf(r[f]);
      const name = v ? maps[kind].get(v) : undefined;
      if (name) display[f] = name;
    }
    if (Object.keys(display).length) r._display = display;
  }
}

/** 编号是 bigint 字符串（偶尔是数字）；其他类型不当编号 */
function idOf(v: unknown): string | undefined {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return undefined;
}
