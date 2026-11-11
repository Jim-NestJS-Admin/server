import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { PlatformContext } from '../../../core/tenant/platform-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { SystemTenantService } from '../../system/service/system-tenant.service.js';
import {
  SystemTenant,
  TenantPackage,
  TenantQuotas,
} from '../entity/tenant.entity.js';

/** 仅显式bootstrap调用；重复执行不重置现有密码或管理员数据。 */
@Injectable()
export class TenantSeedService {
  constructor(
    private readonly platform: PlatformContext,
    private readonly repos: TenantRepositoryFactory,
    private readonly system: SystemTenantService,
  ) {}
  async seed(manager: EntityManager, passwordHash: string, accounts = true) {
    this.platform.assertPlatform();
    if (!manager.queryRunner?.isTransactionActive)
      throw new Error('种子必须在事务内');
    const menus = (await this.system.platformMenus(manager)).filter(
      (menu) => menu.scope === 'tenant',
    );
    const packages = this.repos.for(TenantPackage),
      tenants = this.repos.for(SystemTenant);
    const ensurePackage = async (
      code: string,
      name: string,
      menuIds: string[],
      quotas: TenantQuotas,
    ) => {
      const existing = await packages
        .query('p', manager)
        .andWhere('p.code=:code', { code })
        .getOne();
      return (
        existing?.id ??
        (await packages.insert(
          { code, name, enabled: true, menuIds, quotas, remark: null },
          manager,
        ))
      );
    };
    const all = await ensurePackage(
      'all',
      '全部功能',
      menus.map((menu) => menu.id),
      new TenantQuotas(),
    );
    const defaultTenant = await tenants
      .query('t', manager)
      .andWhere('t.code=:code', { code: 'default' })
      .getOne();
    if (defaultTenant && defaultTenant.id !== '1')
      throw new Error('默认租户编号必须为1');
    if (!defaultTenant) {
      if (await tenants.query('t', manager).withDeleted().getCount())
        throw new Error('目录已有数据但默认租户未登记，需人工核对');
      const id = await tenants.insert(
        {
          code: 'default',
          name: '默认租户',
          packageId: all,
          domains: [],
          enabled: true,
          expiresAt: null,
        },
        manager,
      );
      if (id !== '1') throw new Error('新目录默认租户编号不为1，停止seed');
    }
    if (!accounts)
      return {
        defaultTenant: '1',
        demo: null as string | null,
        platformAdminCreated: false,
      };
    let platformAdminCreated = false;
    if ((await this.system.userCount(manager)) === 0) {
      await this.system.initialize(
        manager,
        '平台',
        'admin',
        passwordHash,
        'platform_admin',
      );
      platformAdminCreated = true;
    }
    const allowed = new Set(
      menus
        .filter((menu) => menu.path === '/system' || menu.path === '/config')
        .map((menu) => menu.id),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const menu of menus)
        if (
          menu.parentId &&
          allowed.has(menu.parentId) &&
          !allowed.has(menu.id)
        ) {
          allowed.add(menu.id);
          changed = true;
        }
    }
    const basic = await ensurePackage(
      'basic',
      '基础版',
      [...allowed],
      Object.assign(new TenantQuotas(), { maxUsers: 5 }),
    );
    let demo = await tenants
      .query('t', manager)
      .andWhere('t.code=:code', { code: 'demo' })
      .getOne();
    if (!demo) {
      const id = await tenants.insert(
        {
          code: 'demo',
          name: '演示租户',
          packageId: basic,
          domains: [],
          enabled: true,
          expiresAt: null,
        },
        manager,
      );
      demo = await tenants
        .query('t', manager)
        .andWhere('t.id=:id', { id })
        .getOne();
    }
    if (!demo) throw new Error('演示租户创建失败');
    const id = demo.id;
    await this.platform.provision(
      id,
      '本地seed：初始化demo管理员',
      async () => {
        if ((await this.system.userCount(manager)) === 0)
          await this.system.initialize(
            manager,
            '演示租户',
            'admin',
            passwordHash,
          );
      },
    );
    return { defaultTenant: '1', demo: id, platformAdminCreated };
  }
}
