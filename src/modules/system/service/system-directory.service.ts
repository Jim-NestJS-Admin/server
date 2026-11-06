import { Injectable } from '@nestjs/common';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import {
  SystemMenu,
  SystemOrg,
  SystemRole,
  SystemUser,
  SystemUserRole,
} from '../entity/system.entity.js';
import type { AuthOrg } from '../../../core/auth/auth-user.store.js';
import type { RoleGrant } from '../../../core/permission/permission-source.js';
import { validOrganizations } from './organization-policy.js';

/** 认证和权限只读数据来源，不向外开放用户、角色写接口。 */
@Injectable()
export class SystemDirectory {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
  ) {}

  private check(tenantId: string): void {
    if (this.context.current().tenantId !== tenantId)
      throw new Error('身份与租户上下文不一致');
  }

  async user(tenantId: string, username: string) {
    this.check(tenantId);
    return this.repos
      .for(SystemUser)
      .query('u')
      .addSelect('u.passwordHash')
      .where('u.username = :username', { username })
      .getOne();
  }

  async profile(tenantId: string, userId: string) {
    this.check(tenantId);
    return this.repos
      .for(SystemUser)
      .query('u')
      .where('u.id = :userId', { userId })
      .getOne();
  }

  async grants(tenantId: string, userId: string): Promise<RoleGrant[]> {
    this.check(tenantId);
    if (!(await this.profile(tenantId, userId))?.enabled) return [];
    const assignments = await this.repos
      .for(SystemUserRole)
      .query('g')
      .where('g.userId = :userId', { userId })
      .getMany();
    if (!assignments.length) return [];
    const roles = await this.repos
      .for(SystemRole)
      .query('r')
      .where('r.id IN (:...ids)', { ids: assignments.map((g) => g.roleId) })
      .andWhere('r.enabled = :enabled', { enabled: true })
      .getMany();
    const map = new Map(roles.map((role) => [role.id, role]));
    const validOrgIds = new Set(
      (await this.orgs(tenantId)).map((org) => org.id),
    );
    return assignments.flatMap((grant) => {
      const role = map.get(grant.roleId);
      return role &&
        (grant.scopeOrgId === null || validOrgIds.has(grant.scopeOrgId))
        ? [
            {
              roleId: role.id,
              scopeOrgId: grant.scopeOrgId,
              permissions: role.permissions,
              allPermissions: role.allPermissions,
              dataScope: role.dataScope,
              customOrgIds: role.customOrgIds,
            },
          ]
        : [];
    });
  }

  async orgs(tenantId: string) {
    this.check(tenantId);
    const rows = await this.repos
      .for(SystemOrg)
      .query('o')
      .where('o.enabled = :enabled', { enabled: true })
      .orderBy('o.rank', 'ASC')
      .addOrderBy('o.id', 'ASC')
      .getMany();
    return validOrganizations(rows);
  }

  async userOrgs(tenantId: string, userId: string): Promise<AuthOrg[]> {
    const grants = await this.grants(tenantId, userId);
    const ids = new Set(grants.map((grant) => grant.scopeOrgId));
    const orgs = await this.orgs(tenantId);
    const map = new Map(orgs.map((org) => [org.id, org]));
    return orgs
      .filter((org) => ids.has(org.id))
      .flatMap((org) => {
        const seen = new Set<string>();
        const path: string[] = [];
        let current: SystemOrg | undefined = org;
        while (current) {
          if (seen.has(current.id)) return [];
          seen.add(current.id);
          path.unshift(current.name);
          if (current.parentId && !map.has(current.parentId)) return [];
          current = current.parentId ? map.get(current.parentId) : undefined;
        }
        return [{ id: org.id, name: org.name, path }];
      });
  }

  async menus(tenantId: string) {
    this.check(tenantId);
    return this.repos
      .for(SystemMenu)
      .query('m')
      .orderBy('m.rank', 'ASC')
      .addOrderBy('m.id', 'ASC')
      .getMany();
  }
}
