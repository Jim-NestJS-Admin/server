import { Injectable } from '@nestjs/common';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import {
  SystemMenu,
  SystemOrg,
  SystemRole,
  SystemUser,
  SystemUserRole,
  SystemUserSupervisor,
} from '../entity/system.entity.js';
import type { AuthOrg } from '../../../core/auth/auth-user.store.js';
import type { RoleGrant } from '../../../core/permission/permission-source.js';
import type { EntityManager } from 'typeorm';
import type { Type } from '@nestjs/common';
import type { BaseEntity } from '../../../core/crud/base.entity.js';
import { validOrganizations } from './organization-policy.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';

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

  async workflowIdentity(
    userId: string,
    orgId: string | null,
    manager: EntityManager,
  ) {
    const user = await this.repos
      .for(SystemUser)
      .query('u', manager)
      .andWhere('u.id = :userId AND u.enabled = :enabled', {
        userId,
        enabled: true,
      })
      .setLock('pessimistic_read')
      .getOne();
    if (!user) return null;
    const orgs = validOrganizations(
      await this.repos
        .for(SystemOrg)
        .query('o', manager)
        .setLock('pessimistic_read')
        .getMany(),
    );
    if (orgId && !orgs.some((o) => o.id === orgId)) return null;
    const assignments = await this.repos
      .for(SystemUserRole)
      .query('g', manager)
      .andWhere(
        'g.userId = :userId AND (g.scopeOrgId IS NULL OR g.scopeOrgId = :orgId)',
        { userId, orgId },
      )
      .setLock('pessimistic_read')
      .getMany();
    const roleIds = assignments.map((g) => g.roleId);
    const roles = roleIds.length
      ? await this.repos
          .for(SystemRole)
          .query('r', manager)
          .andWhere('r.id IN (:...roleIds) AND r.enabled = :enabled', {
            roleIds,
            enabled: true,
          })
          .setLock('pessimistic_read')
          .getMany()
      : [];
    return { userId, orgId, roleIds: roles.map((r) => r.id) };
  }

  async workflowActors(
    type: 'roles' | 'supervisor' | 'department_leader' | 'administrator',
    applicantId: string,
    orgId: string | null,
    ids: string[],
    level: number,
    manager: EntityManager,
  ): Promise<string[]> {
    let candidates: string[] = [];
    if (type === 'department_leader') {
      const orgs = validOrganizations(
        await this.repos
          .for(SystemOrg)
          .query('o', manager)
          .setLock('pessimistic_read')
          .getMany(),
      );
      let org = orgs.find((o) => o.id === orgId);
      for (let n = 1; n < level && org; n++)
        org = orgs.find((o) => o.id === org!.parentId);
      candidates = org?.leaderId ? [org.leaderId] : [];
    } else if (type === 'supervisor') {
      candidates = [applicantId];
      const visited = new Set(candidates);
      for (let n = 0; n < level && candidates.length; n++) {
        const rows = await this.repos
          .for(SystemUserSupervisor)
          .query('s', manager)
          .andWhere('s.userId IN (:...ids)', { ids: candidates })
          .orderBy('s.id', 'ASC')
          .setLock('pessimistic_read')
          .getMany();
        candidates = [...new Set(rows.map((r) => r.supervisorId))].filter(
          (id) => !visited.has(id),
        );
        if (candidates.length > 50)
          throw crudErrors.badRequest('上级关系超过50人限制，请联系管理员调整');
        for (const id of candidates) visited.add(id);
      }
    } else {
      const query = this.repos
        .for(SystemRole)
        .query('r', manager)
        .andWhere('r.enabled = :enabled', { enabled: true });
      if (type === 'roles') {
        if (!ids.length) return [];
        query.andWhere('r.id IN (:...ids)', { ids });
      } else query.andWhere('r.allPermissions = :all', { all: true });
      const roles = await query.setLock('pessimistic_read').getMany();
      if (!roles.length) return [];
      const grants = await this.repos
        .for(SystemUserRole)
        .query('g', manager)
        .andWhere(
          'g.roleId IN (:...ids) AND (g.scopeOrgId IS NULL OR g.scopeOrgId = :orgId)',
          { ids: roles.map((r) => r.id), orgId },
        )
        .orderBy('g.id', 'ASC')
        .setLock('pessimistic_read')
        .getMany();
      candidates = [...new Set(grants.map((g) => g.userId))];
      if (candidates.length > 50 && type === 'roles')
        throw crudErrors.badRequest('角色审批人超过50人限制，请拆分审批角色');
    }
    const enabled = await this.workflowEnabledUsers(candidates, manager);
    return type === 'administrator' ? enabled.slice(0, 1) : enabled;
  }

  /** 运行期只返回仍启用的同租户成员编号，不泄露账号资料。 */
  async workflowEnabledUsers(
    ids: string[],
    manager: EntityManager,
  ): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await this.repos
      .for(SystemUser)
      .query('u', manager)
      .andWhere('u.id IN (:...ids) AND u.enabled = :enabled', {
        ids,
        enabled: true,
      })
      .setLock('pessimistic_read')
      .getMany();
    const enabled = new Set(rows.map((row) => row.id));
    return ids.filter((id) => enabled.has(id));
  }

  /** 流程发布校验只返回引用是否有效，不向workflow泄露用户/角色原始数据。 */
  async workflowReferences(
    refs: { users: string[]; roles: string[]; orgs: string[] },
    manager: EntityManager,
  ): Promise<boolean> {
    const references: [Type<BaseEntity>, string[]][] = [
      [SystemUser, refs.users],
      [SystemRole, refs.roles],
    ];
    for (const [entity, values] of references) {
      if (!values.length) continue;
      const rows = await this.repos
        .for(entity)
        .query('r', manager)
        .andWhere('r.id IN (:...ids)', { ids: values })
        .andWhere('r.enabled = :enabled', { enabled: true })
        .setLock('pessimistic_read')
        .getMany();
      if (rows.length !== values.length) return false;
    }
    if (refs.orgs.length) {
      const rows = await this.repos
        .for(SystemOrg)
        .query('o', manager)
        .setLock('pessimistic_read')
        .getMany();
      const valid = new Set(validOrganizations(rows).map((row) => row.id));
      if (refs.orgs.some((id) => !valid.has(id))) return false;
    }
    return true;
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
    // 菜单平台统一维护；参数保留以兼容PermissionSource，过滤由core按目标租户完成。
    void tenantId;
    return this.context.run({ tenantId: '0' }, () =>
      this.repos
        .for(SystemMenu)
        .query('m')
        .orderBy('m.rank', 'ASC')
        .addOrderBy('m.id', 'ASC')
        .getMany(),
    );
  }
}
