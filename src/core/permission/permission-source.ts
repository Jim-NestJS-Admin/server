import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';

/**
 * 数据范围（架构「数据权限」）。「本组织」指角色作用范围所在的组织；全局角色没有作用范围时取当前组织。
 */
export type DataScopeKind =
  'all' | 'org' | 'org_and_children' | 'self' | 'custom';

/** 用户的一条角色分配：角色 + 作用范围 */
export interface RoleGrant {
  roleId: string;
  /** 作用范围组织；null 是全局角色（任何当前组织下都生效） */
  scopeOrgId: string | null;
  /** 角色拥有的权限码（按钮菜单上的权限码） */
  permissions: string[];
  /** 超级管理员：拥有全部权限码 */
  allPermissions?: boolean;
  dataScope: DataScopeKind;
  /** dataScope = custom 时的组织 */
  customOrgIds?: string[];
}

export interface OrgNode {
  id: string;
  parentId: string | null;
}

/** 菜单（sys_menu）。按钮类只用于后台配置权限码，不返回给前端的菜单树 */
export interface MenuNode {
  id: string;
  parentId: string | null;
  type: 'directory' | 'page' | 'button';
  path: string;
  title: string;
  icon?: string | null;
  rank: number;
  /** 页面：前端页面的相对路径 */
  component?: string | null;
  /** 页面、按钮：需要的权限码；页面不填表示登录就能看 */
  permission?: string | null;
  keepAlive?: boolean;
  hidden?: boolean;
}

/**
 * 权限计算读取角色、组织、菜单的接口，由 system 模块（T07）实现，
 * `PermissionModule.forRoot({ source: SystemPermissionSource, imports: [SystemModule] })` 接入。
 *
 * 实现方的义务：改角色（权限码、数据范围）、改角色分配、改组织树、调整组织成员、改菜单时，
 * **数据库提交之后**调用 PermissionService.bumpVersion(tenantId)，旧的权限缓存立即失效。
 * 每次都读数据库最新值，不要自己缓存（缓存由权限服务按授权版本统一做）。
 */
export abstract class PermissionSource {
  /** 用户在这个租户里的全部角色分配（全局 + 各组织） */
  abstract loadGrants(tenantId: string, userId: string): Promise<RoleGrant[]>;
  /** 租户的组织树（只要 id 和上级） */
  abstract loadOrgs(tenantId: string): Promise<OrgNode[]>;
  /** 租户的全部菜单（目录、页面、按钮） */
  abstract loadMenus(tenantId: string): Promise<MenuNode[]>;
}

/**
 * system 模块（T07）接入之前的默认实现：没有任何角色，后台业务接口一律 403。
 * 生产环境启动时直接拒绝。
 */
@Injectable()
export class UnconfiguredPermissionSource
  extends PermissionSource
  implements OnModuleInit
{
  private readonly logger = new Logger('PermissionSource');

  constructor(private readonly config: AppConfigService) {
    super();
  }

  onModuleInit(): void {
    if (this.config.isProduction && !this.config.openApiExport)
      throw new Error(
        '角色和菜单（T07）还没有接入权限，生产环境不能启动：请提供 PermissionSource 的实现',
      );
    this.logger.warn(
      '角色和菜单还没有接入权限（PermissionSource），后台业务接口都会 403',
    );
  }

  async loadGrants(): Promise<RoleGrant[]> {
    return [];
  }
  async loadOrgs(): Promise<OrgNode[]> {
    return [];
  }
  async loadMenus(): Promise<MenuNode[]> {
    return [];
  }
}
