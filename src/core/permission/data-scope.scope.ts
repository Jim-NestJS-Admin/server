import { Injectable } from '@nestjs/common';
import {
  col,
  TenantOnlyScope,
  type ScopeCondition,
} from '../crud/crud-scope.js';
import type {
  CrudAction,
  CrudContext,
  CrudResourceMeta,
} from '../crud/crud.types.js';
import { AuthzContext } from './authz-context.js';

/**
 * 通用 CRUD 的范围条件：租户 + 数据范围（T06）。
 * 资源声明了 dataScope 时，按本次有效角色的数据范围之并过滤：
 * 全部 → 不加条件；否则「所属组织在范围内」或「创建人是自己」（仅本人），都没有就什么都看不到。
 * 读、改、删、回收站都用同一组条件，范围外的数据和不存在一样（404）。
 * 后台任务（RequestContext.run）没有用户、不按数据范围过滤；后台请求没有授权结果时什么都看不到。
 */
@Injectable()
export class DataScopeCrudScope extends TenantOnlyScope {
  constructor(private readonly authz: AuthzContext) {
    super();
  }

  conditions(
    ctx: CrudContext,
    meta: CrudResourceMeta,
    action: CrudAction,
    alias?: string,
  ): ScopeCondition[] {
    const out = super.conditions(ctx, meta, action, alias);
    if (!meta.dataScope || ctx.endpoint === 'system') return out;
    const a = this.authz.get();
    if (!a) return [...out, { sql: '1 = 0', params: {} }];
    const ds = a.dataScope;
    if (ds.all) return out;
    const parts: string[] = [];
    const params: Record<string, unknown> = {};
    if (ds.orgIds.length) {
      parts.push(`${col(alias, 'org_id')} IN (:...__dsOrgs)`);
      params.__dsOrgs = [...ds.orgIds];
    }
    if (ds.self && ctx.userId) {
      parts.push(`${col(alias, 'created_by')} = :__dsUser`);
      params.__dsUser = ctx.userId;
    }
    out.push(
      parts.length
        ? { sql: `(${parts.join(' OR ')})`, params }
        : { sql: '1 = 0', params: {} },
    );
    return out;
  }
}
