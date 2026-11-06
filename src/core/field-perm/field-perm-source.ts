import { Injectable } from '@nestjs/common';
import type { FieldState, MaskRule } from './field-perm.decorator.js';

/** resource 是资源的权限码前缀（如 system:user），field 是实体属性名 */
export interface FieldRule {
  resource: string;
  field: string;
  state: FieldState;
  mask?: MaskRule | null;
}

export interface RoleFieldRule extends FieldRule {
  roleId: string;
}

/**
 * 字段权限配置的读取接口，由 system 模块（T07）实现（契约 docs/contracts/field-perm.md 第 4 节）。
 * 管理接口保存后调用 PermissionService.bumpVersion(租户)；这里每次读数据库最新值，缓存由权限服务统一做。
 */
export abstract class FieldPermSource {
  /** sys_field：后台改过的模块字段默认值 */
  abstract loadFieldDefaults(tenantId: string): Promise<FieldRule[]>;
  /** sys_role_field：各角色单独设置的字段状态 */
  abstract loadRoleFields(tenantId: string): Promise<RoleFieldRule[]>;
}

/** 没有接入时：只用代码里 @FieldPerm 的默认值 */
@Injectable()
export class CodeOnlyFieldPermSource extends FieldPermSource {
  async loadFieldDefaults(): Promise<FieldRule[]> {
    return [];
  }
  async loadRoleFields(): Promise<RoleFieldRule[]> {
    return [];
  }
}
