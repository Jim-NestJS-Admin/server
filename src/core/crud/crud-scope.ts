import { Injectable } from '@nestjs/common';
import { RequestContext } from '../tenant/request-context.js';
import type {
  CrudAction,
  CrudContext,
  CrudResourceMeta,
} from './crud.types.js';

export interface ScopeCondition {
  /** SQL 条件，列名用数据库列名，参数名以 __ 开头避免和业务参数冲突 */
  sql: string;
  params: Record<string, unknown>;
}

/**
 * 读、改、删时框架自动附加的条件（租户、数据范围）。
 * 现在只有租户（平台管理员的 @IgnoreTenant 请求不加租户条件，且只能读）；
 * T06 在这里加「本次有效角色的数据范围」。
 * 所有 CRUD 读写都必须经过它，不允许业务代码绕开。
 */
export abstract class CrudScope {
  abstract conditions(
    ctx: CrudContext,
    meta: CrudResourceMeta,
    action: CrudAction,
    alias?: string,
  ): ScopeCondition[];
}

/** 列引用：查询里带别名（e.tenant_id），条件更新里不带别名（MySQL 的 UPDATE 不认别名） */
export const col = (alias: string | undefined, column: string) =>
  alias ? `${alias}.\`${column}\`` : `\`${column}\``;

@Injectable()
export class TenantOnlyScope extends CrudScope {
  conditions(
    ctx: CrudContext,
    _meta: CrudResourceMeta,
    _action: CrudAction,
    alias?: string,
  ): ScopeCondition[] {
    if (ctx.ignoreTenant) return [];
    return [
      {
        sql: `${col(alias, 'tenant_id')} = :__tenantId`,
        params: { __tenantId: ctx.tenantId },
      },
    ];
  }
}

/** 从请求上下文取租户、当前用户和当前组织；没有上下文直接报错（不再默认落到某个租户） */
@Injectable()
export class CrudContextProvider {
  constructor(private readonly context: RequestContext) {}

  current(): CrudContext {
    const c = this.context.current();
    return {
      tenantId: c.tenantId,
      userId: c.userId,
      orgId: c.orgId,
      ignoreTenant: c.ignoreTenant,
    };
  }
}
