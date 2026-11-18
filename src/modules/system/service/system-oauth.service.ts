import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { IdempotencyLedger } from '../../../core/security/idempotency.ledger.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { TenantQuotaService } from '../../tenant/service/tenant-quota.service.js';
import {
  SystemUser,
  SystemOrg,
  SystemUserRole,
} from '../entity/system.entity.js';
import { SystemUserRoleService } from './system-management.service.js';
import { PermissionService } from '../../../core/permission/permission.service.js';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../core/exceptions/error-code.js';
@Injectable()
export class SystemOAuthService {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
    private readonly ledger: IdempotencyLedger,
    private readonly quota: TenantQuotaService,
    private readonly grants: SystemUserRoleService,
    private readonly permissions: PermissionService,
  ) {}
  async identity(id: string, manager?: EntityManager) {
    const user = await this.repos
      .for(SystemUser)
      .query('u', manager)
      .addSelect('u.accountType')
      .andWhere('u.id=:id AND u.enabled=:enabled', { id, enabled: true })
      .getOne();
    return user ? { id: user.id, type: user.accountType } : null;
  }
  async assertService(id: string, orgId: string, manager?: EntityManager) {
    const user = await this.identity(id, manager);
    const org = await this.repos
      .for(SystemOrg)
      .query('o', manager)
      .andWhere('o.id=:id AND o.enabled=:enabled', { id: orgId, enabled: true })
      .getOne();
    if (user?.type !== 'service' || !org)
      throw crudErrors.badRequest('服务账号或组织不可用');
  }
  async create(name: string, orgId: string) {
    if (this.context.current().tenantId === '0')
      throw crudErrors.badRequest('服务账号只能属于业务租户');
    return this.ledger.transaction((manager) =>
      this.createInTx(name, orgId, manager),
    );
  }
  private async createInTx(
    name: string,
    orgId: string,
    manager: EntityManager,
  ) {
    await this.quota.assertCanAddUser(this.context.current().tenantId, manager);
    const org = await this.repos
      .for(SystemOrg)
      .query('o', manager)
      .andWhere('o.id=:id AND o.enabled=:enabled', {
        id: orgId,
        enabled: true,
      })
      .getOne();
    if (!org) throw crudErrors.badRequest('组织不可用');
    return {
      id: await this.repos.for(SystemUser).insert(
        {
          username: `service_${randomUUID().replaceAll('-', '')}`,
          nickname: name,
          passwordHash: '',
          enabled: true,
          defaultOrgId: orgId,
          locale: 'zh-CN',
          avatar: null,
          accountType: 'service',
        },
        manager,
      ),
    };
  }
  async provisionIntegration(
    name: string,
    orgId: string,
    roleIds: string[],
    manager: EntityManager,
    existingUserId?: string,
  ) {
    const actor = this.context.current();
    if (actor.tenantId === '0')
      throw crudErrors.badRequest('服务账号只能属于业务租户');
    return this.context.runFresh({ ...actor, orgId }, async () => {
      if (!(await this.permissions.isSuperAdmin()))
        throw new BusinessException(
          ErrorCode.Forbidden,
          '只有租户管理员可以配置系统对接权限',
          403,
        );
      let userId = existingUserId;
      if (userId) {
        await this.assertService(userId, orgId, manager);
        await this.repos
          .for(SystemUser)
          .update([userId], { nickname: name, defaultOrgId: orgId }, manager);
      } else userId = (await this.createInTx(name, orgId, manager)).id;
      const permissions = await this.grants.replaceServiceRoles(
        userId,
        orgId,
        roleIds,
        manager,
      );
      return { userId, permissions };
    });
  }
  async integrationRoles(userId: string) {
    return (
      await this.repos
        .for(SystemUserRole)
        .query('g')
        .andWhere('g.userId=:userId', { userId })
        .getMany()
    ).map((row) => row.roleId);
  }
}
