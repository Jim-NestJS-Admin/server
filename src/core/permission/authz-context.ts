import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

/** 本次请求的数据范围：本次有效角色的数据范围之并 */
export interface DataScopeGrant {
  all: boolean;
  orgIds: string[];
  /** 「仅本人」：创建人是当前用户 */
  self: boolean;
}

/** 本次有效角色之一：字段权限按行合并时要知道每个角色自己的数据范围 */
export interface EffectiveRole {
  roleId: string;
  superAdmin: boolean;
  scope: DataScopeGrant;
}

/** 字段权限配置：key 是「资源.字段」 */
export interface FieldRules {
  defaults: Record<string, { state: string; mask?: string | null }>;
  /** 只含本次有效角色 */
  roles: Record<
    string,
    Record<string, { state: string; mask?: string | null }>
  >;
}

/** 权限守卫算出的本次授权，供 CRUD 的数据范围条件和字段权限使用 */
export interface Authorization {
  permission: string;
  roleIds: string[];
  dataScope: DataScopeGrant;
  roles: EffectiveRole[];
  fields: FieldRules;
}

const KEY = 'jna:authz';

/** 本次请求的授权结果（CLS）。由权限守卫写一次，之后只读 */
@Injectable()
export class AuthzContext {
  constructor(private readonly cls: ClsService) {}

  set(authz: Authorization): void {
    if (this.cls.get(KEY)) throw new Error('本次请求的授权已经确定，不能再改');
    this.cls.set(
      KEY,
      Object.freeze({
        ...authz,
        roleIds: Object.freeze([...authz.roleIds]),
        dataScope: Object.freeze({
          ...authz.dataScope,
          orgIds: Object.freeze([...authz.dataScope.orgIds]),
        }),
        roles: Object.freeze(
          authz.roles.map((r) =>
            Object.freeze({
              ...r,
              scope: Object.freeze({
                ...r.scope,
                orgIds: Object.freeze([...r.scope.orgIds]),
              }),
            }),
          ),
        ),
        fields: Object.freeze(authz.fields),
      }),
    );
  }

  /** 没有（登录即可的接口、后台任务）时返回 undefined */
  get(): Readonly<Authorization> | undefined {
    return this.cls.isActive() ? this.cls.get(KEY) : undefined;
  }
}
