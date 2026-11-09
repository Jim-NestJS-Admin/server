import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';
import { RedisService } from '../redis/redis.service.js';
import { RequestContext } from '../tenant/request-context.js';
import {
  AuthzContext,
  type DataScopeGrant,
  type FieldRules,
} from './authz-context.js';
import { FieldPermSource } from '../field-perm/field-perm-source.js';
import { PermissionRegistry } from './permission-registry.js';
import {
  PermissionSource,
  type MenuNode,
  type OrgNode,
  type RoleGrant,
} from './permission-source.js';

/** 当前组织下生效的一个角色（已经算好数据范围） */
interface ActiveRole {
  roleId: string;
  all: boolean;
  perms: string[];
  scope: DataScopeGrant;
}

/** 缓存的内容：key 带租户、用户、当前组织和授权版本 */
interface UserAuthz {
  /** 当前组织里还有角色，或者是全局超级管理员（没有当前组织时为 true） */
  orgValid: boolean;
  roles: ActiveRole[];
}

export interface MenuItem {
  id: string;
  type: 'directory' | 'page';
  path: string;
  title: string;
  icon: string | null;
  rank: number;
  component?: string | null;
  permission?: string | null;
  keepAlive?: boolean;
  hidden?: boolean;
  children?: MenuItem[];
}

const CACHE_TTL = 3600;
const NO_ORG = '-';

const forbidden = () =>
  new BusinessException(ErrorCode.Forbidden, '没有权限', HttpStatus.FORBIDDEN);
const unauthorized = () =>
  new BusinessException(
    ErrorCode.Unauthorized,
    undefined,
    HttpStatus.UNAUTHORIZED,
  );

/** 某个组织和它的全部下级 */
function subtree(orgs: OrgNode[], root: string): string[] {
  const children = new Map<string, string[]>();
  for (const o of orgs)
    if (o.parentId)
      children.set(o.parentId, [...(children.get(o.parentId) ?? []), o.id]);
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

/**
 * 权限计算（架构「认证与权限 · 有效角色的计算」）：
 * 1. 当前组织下生效的角色 = 作用范围是当前组织的角色 + 全局角色；
 * 2. 只留下授予了本次动作权限码的角色（本次有效角色），一个都没有就 403；
 * 3. 数据范围 = 本次有效角色的数据范围之并（不会把 A 角色的动作和 B 角色的数据范围拼起来）。
 * 用户的角色按「租户、用户、当前组织、授权版本」缓存在 Redis；改角色、组织树、成员、菜单时授权版本加 1。
 */
@Injectable()
export class PermissionService {
  constructor(
    private readonly redis: RedisService,
    private readonly source: PermissionSource,
    private readonly registry: PermissionRegistry,
    private readonly context: RequestContext,
    private readonly authz: AuthzContext,
    private readonly fieldSource: FieldPermSource,
  ) {}

  /** 租户的字段权限配置（按授权版本缓存），只留本次有效角色的 */
  private async fieldRules(
    tenantId: string,
    roleIds: string[],
  ): Promise<FieldRules> {
    const version = await this.version(tenantId);
    const key = this.redis.tenantKey(tenantId, 'fieldperm', `v${version}`);
    type Cached = {
      defaults: FieldRules['defaults'];
      roles: FieldRules['roles'];
    };
    let all: Cached;
    const cached = await this.redis.call((r) => r.get(key));
    if (cached) all = JSON.parse(cached) as Cached;
    else {
      const [defaults, roleRules] = await Promise.all([
        this.fieldSource.loadFieldDefaults(tenantId),
        this.fieldSource.loadRoleFields(tenantId),
      ]);
      all = { defaults: {}, roles: {} };
      for (const d of defaults)
        all.defaults[`${d.resource}.${d.field}`] = {
          state: d.state,
          mask: d.mask ?? null,
        };
      for (const r of roleRules)
        (all.roles[r.roleId] ??= {})[`${r.resource}.${r.field}`] = {
          state: r.state,
          mask: r.mask ?? null,
        };
      await this.redis.call((r) =>
        r.set(key, JSON.stringify(all), 'EX', CACHE_TTL),
      );
    }
    const roles: FieldRules['roles'] = {};
    for (const id of roleIds) if (all.roles[id]) roles[id] = all.roles[id];
    return { defaults: all.defaults, roles };
  }

  private versionKey(tenantId: string) {
    return this.redis.tenantKey(tenantId, 'perm', 'ver');
  }

  /** 租户的授权版本 */
  async version(tenantId: string): Promise<number> {
    const v = await this.redis.call((r) => r.get(this.versionKey(tenantId)));
    return Number(v ?? 0);
  }

  /**
   * 授权版本加 1：改角色（权限码、数据范围）、角色分配、组织树、组织成员、菜单之后，数据库提交了再调用。
   * 这个租户所有用户的权限缓存立即失效，下一次请求按新配置计算。
   */
  async bumpVersion(tenantId: string): Promise<number> {
    return this.redis.call((r) => r.incr(this.versionKey(tenantId)));
  }

  /** 读取（或计算并缓存）用户在当前组织下的角色 */
  private async load(
    tenantId: string,
    userId: string,
    orgId: string | null,
  ): Promise<{ authz: UserAuthz; version: number }> {
    const version = await this.version(tenantId);
    const key = this.redis.tenantKey(
      tenantId,
      'perm',
      userId,
      orgId ?? NO_ORG,
      `v${version}`,
    );
    const cached = await this.redis.call((r) => r.get(key));
    if (cached) return { authz: JSON.parse(cached) as UserAuthz, version };
    const authz = await this.compute(tenantId, userId, orgId);
    await this.redis.call((r) =>
      r.set(key, JSON.stringify(authz), 'EX', CACHE_TTL),
    );
    return { authz, version };
  }

  private async compute(
    tenantId: string,
    userId: string,
    orgId: string | null,
  ): Promise<UserAuthz> {
    const grants = await this.source.loadGrants(tenantId, userId);
    const active = grants.filter(
      (g) => g.scopeOrgId === null || g.scopeOrgId === orgId,
    );
    let orgs: OrgNode[] | null = null;
    const tree = async () => (orgs ??= await this.source.loadOrgs(tenantId));
    const roles: ActiveRole[] = [];
    for (const g of active)
      roles.push({
        roleId: g.roleId,
        all: g.allPermissions === true,
        perms: [...new Set(g.permissions)],
        scope: await this.scopeOf(g, orgId, tree),
      });
    return {
      // 当前组织有效：在这个组织有角色，或者是全局超级管理员（在任何组织都有效）
      orgValid:
        orgId === null ||
        grants.some(
          (g) =>
            g.scopeOrgId === orgId ||
            (g.scopeOrgId === null && g.allPermissions),
        ),
      roles,
    };
  }

  private async scopeOf(
    g: RoleGrant,
    orgId: string | null,
    tree: () => Promise<OrgNode[]>,
  ): Promise<DataScopeGrant> {
    const none: DataScopeGrant = { all: false, orgIds: [], self: false };
    const base = g.scopeOrgId ?? orgId;
    switch (g.dataScope) {
      case 'all':
        return { ...none, all: true };
      case 'self':
        return { ...none, self: true };
      case 'org':
        return { ...none, orgIds: base ? [base] : [] };
      case 'org_and_children':
        return { ...none, orgIds: base ? subtree(await tree(), base) : [] };
      case 'custom':
        return { ...none, orgIds: [...new Set(g.customOrgIds ?? [])] };
      default:
        // 不认识的范围按「什么都看不到」处理
        return none;
    }
  }

  /**
   * 权限守卫调用：核对本次动作的权限码，算出本次有效角色和数据范围，写进本次请求的授权上下文。
   * 当前组织里已经没有角色（被移出组织、角色被收回）：401，前端刷新失败后回登录页重新选组织。
   */
  async authorize(code: string): Promise<void> {
    const { tenantId, userId, orgId } = this.context.current();
    if (!userId) throw unauthorized();
    const { authz } = await this.load(tenantId, userId, orgId);
    if (!authz.orgValid) throw unauthorized();
    const effective = authz.roles.filter(
      (r) => r.all || r.perms.includes(code),
    );
    if (effective.length === 0) throw forbidden();
    const orgIds = new Set<string>();
    for (const r of effective) for (const id of r.scope.orgIds) orgIds.add(id);
    const roleIds = effective.map((r) => r.roleId);
    this.authz.set({
      permission: code,
      roleIds,
      roles: effective.map((r) => ({
        roleId: r.roleId,
        superAdmin: r.all,
        scope: r.scope,
      })),
      fields: await this.fieldRules(tenantId, roleIds),
      dataScope: {
        all: effective.some((r) => r.scope.all),
        orgIds: [...orgIds].sort(),
        self: effective.some((r) => r.scope.self),
      },
    });
  }

  /** 登录即可、不核对组织的接口：只要有当前用户 */
  async assertUser(): Promise<void> {
    if (!this.context.current().userId) throw unauthorized();
  }

  /** 登录即可的接口也核对当前组织归属 */
  async assertMember(): Promise<void> {
    const { tenantId, userId, orgId } = this.context.current();
    if (!userId) throw unauthorized();
    const { authz } = await this.load(tenantId, userId, orgId);
    if (!authz.orgValid) throw unauthorized();
  }

  /** 当前用户在当前组织下的权限码（明确列表，没有通配符；超级管理员是全部） */
  async permissions(): Promise<{ codes: string[]; version: number }> {
    const { tenantId, userId, orgId } = this.context.current();
    if (!userId) throw unauthorized();
    const { authz, version } = await this.load(tenantId, userId, orgId);
    if (!authz.orgValid) throw unauthorized();
    const codes = new Set<string>();
    if (authz.roles.some((r) => r.all)) {
      for (const p of this.registry.all()) codes.add(p.code);
      for (const m of await this.source.loadMenus(tenantId))
        if (m.permission) codes.add(m.permission);
    }
    for (const r of authz.roles) for (const p of r.perms) codes.add(p);
    return { codes: [...codes].sort(), version };
  }

  /** 菜单树（不含按钮）+ 权限码 + 授权版本（契约 sessionMenu） */
  async menu(): Promise<{
    menus: MenuItem[];
    permissions: string[];
    authVersion: number;
  }> {
    const { codes, version } = await this.permissions();
    const has = new Set(codes);
    const all = await this.source.loadMenus(this.context.current().tenantId);
    const byParent = new Map<string | null, MenuNode[]>();
    for (const m of all)
      if (m.type !== 'button')
        byParent.set(m.parentId, [...(byParent.get(m.parentId) ?? []), m]);
    const build = (parentId: string | null, depth: number): MenuItem[] => {
      if (depth > 10) return [];
      const out: MenuItem[] = [];
      for (const m of (byParent.get(parentId) ?? []).sort(
        (a, b) => a.rank - b.rank,
      )) {
        const base = {
          id: m.id,
          path: m.path,
          title: m.title,
          icon: m.icon ?? null,
          rank: m.rank,
        };
        if (m.type === 'directory') {
          const children = build(m.id, depth + 1);
          if (children.length)
            out.push({ ...base, type: 'directory', children });
        } else if (!m.permission || has.has(m.permission)) {
          out.push({
            ...base,
            type: 'page',
            component: m.component ?? null,
            permission: m.permission ?? null,
            keepAlive: m.keepAlive ?? false,
            hidden: m.hidden ?? false,
          });
        }
      }
      return out;
    };
    return { menus: build(null, 0), permissions: codes, authVersion: version };
  }
}
