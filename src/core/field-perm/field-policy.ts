import type {
  Authorization,
  DataScopeGrant,
} from '../permission/authz-context.js';
import {
  fieldPermOf,
  STATE_RANK,
  type FieldState,
  type MaskRule,
} from './field-perm.decorator.js';

export interface FieldVerdict {
  state: FieldState;
  mask: MaskRule | null;
}

/** 行的归属：所属组织和创建人；null 表示不针对具体行（页面描述取最宽状态） */
export type RowOwner = {
  orgId: string | null;
  createdBy: string | null;
} | null;

const covers = (scope: DataScopeGrant, row: RowOwner, userId: string | null) =>
  !row ||
  scope.all ||
  (row.orgId !== null && scope.orgIds.includes(row.orgId)) ||
  (scope.self && row.createdBy !== null && row.createdBy === userId);

const asState = (v: unknown): FieldState | undefined =>
  typeof v === 'string' && v in STATE_RANK ? (v as FieldState) : undefined;

/**
 * 某一行的某个字段对当前用户是什么状态（架构「字段权限 · 多角色合并」）：
 * 只看本次有效角色里数据范围覆盖这一行的角色（资源不按数据范围过滤时，本次有效角色都算），
 * 每个角色的状态 = 角色单独设置 → 后台模块默认 → 代码 @FieldPerm 默认 → 可编辑，取最宽松的。
 * 超级管理员一律可编辑。没有任何角色覆盖：隐藏（失败关闭）。
 */
export function fieldVerdict(
  authz: Readonly<Authorization>,
  userId: string | null,
  resource: string,
  entity: Function,
  field: string,
  dataScoped: boolean,
  row: RowOwner,
): FieldVerdict {
  const key = `${resource}.${field}`;
  const code = fieldPermOf(entity, field);
  const base = authz.fields.defaults[key];
  const fallbackState =
    asState(base?.state) ?? code?.default ?? ('editable' as FieldState);
  const fallbackMask = (base?.mask ?? code?.mask ?? null) as MaskRule | null;
  let best: FieldVerdict | null = null;
  for (const role of authz.roles) {
    if (dataScoped && !covers(role.scope, row, userId)) continue;
    if (role.superAdmin) return { state: 'editable', mask: null };
    const own = authz.fields.roles[role.roleId]?.[key];
    const v: FieldVerdict = {
      state: asState(own?.state) ?? fallbackState,
      mask: (own?.mask as MaskRule | null | undefined) ?? fallbackMask,
    };
    if (!best || STATE_RANK[v.state] > STATE_RANK[best.state]) best = v;
  }
  return best ?? { state: 'hidden', mask: null };
}
