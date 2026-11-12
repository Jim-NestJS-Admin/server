import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import {
  PasswordHasher,
  checkPasswordPolicy,
  normalizeUsername,
} from '../../../core/auth/password.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import {
  SystemOrg,
  SystemRole,
  SystemUser,
  SystemUserRole,
  SystemMenu,
} from '../entity/system.entity.js';

/** 只暴露系统模块的初始化/计数与平台菜单读取，不向其他模块暴露Repository。 */
@Injectable()
export class SystemTenantService {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
  ) {}
  validateAdmin(username: string, password: string): string {
    const name = normalizeUsername(username);
    if (!/^[a-z][a-z0-9_.-]{2,63}$/.test(name))
      throw crudErrors.badRequest('管理员账号格式不正确', [
        {
          field: 'adminUsername',
          messages: ['账号为3至64位字母、数字或._-，以字母开头'],
        },
      ]);
    const errors = checkPasswordPolicy(password, name);
    if (errors.length)
      throw crudErrors.badRequest('管理员密码不符合要求', [
        { field: 'adminPassword', messages: errors },
      ]);
    return name;
  }
  async initialize(
    manager: EntityManager,
    name: string,
    username: string,
    passwordHash: string,
    roleCode = 'tenant_admin',
  ) {
    if (!manager.queryRunner?.isTransactionActive)
      throw new Error('租户初始化必须在事务内');
    const orgId = await this.repos
      .for(SystemOrg)
      .insert({ name, parentId: null, enabled: true, rank: 0 }, manager);
    const roleId = await this.repos.for(SystemRole).insert(
      {
        code: roleCode,
        name: roleCode === 'platform_admin' ? '平台管理员' : '租户管理员',
        enabled: true,
        allPermissions: true,
        permissions: [],
        dataScope: 'all',
        customOrgIds: [],
      },
      manager,
    );
    const userId = await this.repos.for(SystemUser).insert(
      {
        username,
        passwordHash,
        nickname: '管理员',
        enabled: true,
        defaultOrgId: orgId,
        avatar: null,
        locale: 'zh-CN',
      },
      manager,
    );
    await this.repos
      .for(SystemUserRole)
      .insert({ userId, roleId, scopeOrgId: null }, manager);
    return { userId, roleId, orgId };
  }
  passwordHash(password: string) {
    return PasswordHasher.hash(password);
  }
  async userCount(manager?: EntityManager): Promise<number> {
    const query = this.repos
      .for(SystemUser)
      .query('u', manager)
      .select(['u.id']);
    if (manager?.queryRunner?.isTransactionActive)
      query.setLock('pessimistic_read');
    return (await query.getMany()).length;
  }
  async platformMenus(manager?: EntityManager) {
    return this.context.run({ tenantId: '0' }, () =>
      this.repos
        .for(SystemMenu)
        .query('m', manager)
        .orderBy('m.rank', 'ASC')
        .addOrderBy('m.id', 'ASC')
        .getMany(),
    );
  }
}
