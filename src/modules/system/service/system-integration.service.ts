import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { TenantQuotaService } from '../../tenant/service/tenant-quota.service.js';
import {
  SystemOrg,
  SystemUser,
  SystemUserRole,
} from '../entity/system.entity.js';

/** 外部同步只通过system模块写入，不能按平台ID自动绑定既有本地账号。 */
@Injectable()
export class SystemIntegrationService {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly quota: TenantQuotaService,
  ) {}
  async organization(
    source: string,
    name: string,
    parentId: string,
    rank: number,
    manager: EntityManager,
  ) {
    const old = await this.repos
      .for(SystemOrg)
      .query('o', manager)
      .andWhere('o.integrationSource = :source', { source })
      .getOne();
    const values = {
      integrationSource: source,
      name,
      parentId,
      rank,
      enabled: true,
    };
    if (old) {
      await this.repos.for(SystemOrg).update([old.id], values, manager);
      return old.id;
    }
    return this.repos
      .for(SystemOrg)
      .insert({ ...values, leaderId: null }, manager);
  }
  async member(
    input: {
      tenantId: string;
      source: string;
      name: string;
      defaultOrgId: string;
      orgIds: string[];
      enabled: boolean;
      defaultRoleId: string | null;
    },
    manager: EntityManager,
  ) {
    let user = await this.repos
      .for(SystemUser)
      .query('u', manager)
      .andWhere('u.integrationSource = :source', { source: input.source })
      .getOne();
    if (!user) {
      await this.quota.assertCanAddUser(input.tenantId, manager);
      const userId = await this.repos.for(SystemUser).insert(
        {
          username:
            'wx_' +
            createHash('sha256')
              .update(input.source)
              .digest('hex')
              .slice(0, 40),
          nickname: input.name,
          enabled: input.enabled,
          defaultOrgId: input.defaultOrgId,
          integrationSource: input.source,
          passwordHash: '',
          locale: 'zh-CN',
          avatar: null,
        },
        manager,
      );
      // 空哈希不匹配任何密码；必须显式设置密码才能使用账号密码登录。
      user = Object.assign(new SystemUser(), {
        id: userId,
        enabled: input.enabled,
      });
      if (input.defaultRoleId)
        for (const scopeOrgId of input.orgIds)
          await this.repos
            .for(SystemUserRole)
            .insert(
              { userId, roleId: input.defaultRoleId, scopeOrgId },
              manager,
            );
    } else {
      await this.repos.for(SystemUser).update(
        [user.id],
        {
          nickname: input.name,
          enabled: input.enabled,
          defaultOrgId: input.defaultOrgId,
        },
        manager,
      );
    }
    const managedOrgs = await this.repos
      .for(SystemOrg)
      .query('o', manager)
      .andWhere('o.integrationSource IS NOT NULL')
      .getMany();
    const managedIds = managedOrgs.map((o) => o.id);
    if (managedIds.length) {
      const assignments = await this.repos
        .for(SystemUserRole)
        .query('g', manager)
        .andWhere('g.userId = :userId AND g.scopeOrgId IN (:...orgIds)', {
          userId: user.id,
          orgIds: managedIds,
        })
        .getMany();
      for (const assignment of assignments)
        if (
          assignment.scopeOrgId &&
          !input.orgIds.includes(assignment.scopeOrgId)
        )
          await this.repos.for(SystemUserRole).remove([assignment.id], manager);
      // 部门调整只收回已离开部门的作用范围，不把旧部门角色复制到新部门。
      // 新部门的权限仍由后台管理员显式分配。
    }
    return { id: user.id, disabled: !input.enabled };
  }
  async disable(source: string, manager: EntityManager) {
    const user = await this.repos
      .for(SystemUser)
      .query('u', manager)
      .andWhere('u.integrationSource = :source', { source })
      .getOne();
    if (!user) return null;
    await this.repos
      .for(SystemUser)
      .update([user.id], { enabled: false }, manager);
    return user.id;
  }
  async disableOrganization(source: string, manager: EntityManager) {
    const org = await this.repos
      .for(SystemOrg)
      .query('o', manager)
      .andWhere('o.integrationSource = :source', { source })
      .getOne();
    if (org)
      await this.repos
        .for(SystemOrg)
        .update([org.id], { enabled: false }, manager);
  }
  async requireLocalOrganization(id: string, manager: EntityManager) {
    const row = await this.repos
      .for(SystemOrg)
      .query('o', manager)
      .andWhere('o.id = :id', { id })
      .getOne();
    if (!row?.enabled || row.integrationSource)
      throw crudErrors.badRequest('挂载点必须是启用的本地组织');
  }
}
