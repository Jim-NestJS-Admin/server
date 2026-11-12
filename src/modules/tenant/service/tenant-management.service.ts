import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import { BaseService, type CrudRow } from '../../../core/crud/base.service.js';
import type { CrudTx } from '../../../core/crud/crud.types.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { PlatformContext } from '../../../core/tenant/platform-context.js';
import { PlatformAuditSink } from '../../../core/tenant/platform-context.js';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../core/exceptions/error-code.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { PermissionService } from '../../../core/permission/permission.service.js';
import { SystemTenantService } from '../../system/service/system-tenant.service.js';
import { FileUsageService } from '../../file/service/file-usage.service.js';
import {
  SystemTenant,
  TenantPackage,
  TenantQuotas,
  QUOTA_FIELDS,
} from '../entity/tenant.entity.js';
import type {
  CreateTenantBody,
  TenantUsageResult,
  PackageMenuItem,
} from '../dto/tenant.dto.js';

@Injectable()
export class TenantManagementService extends BaseService<SystemTenant> {
  @Inject(PlatformAuditSink) private readonly platformAudit!: PlatformAuditSink;
  @Inject(PlatformContext) private readonly platform!: PlatformContext;
  @Inject(TenantRepositoryFactory)
  private readonly repos!: TenantRepositoryFactory;
  @Inject(SystemTenantService) private readonly system!: SystemTenantService;
  @Inject(FileUsageService) private readonly files!: FileUsageService;
  @Inject(RequestContext) private readonly context!: RequestContext;
  @Inject(PermissionService) private readonly permission!: PermissionService;
  private readonly creation = new AsyncLocalStorage<{
    username: string;
    passwordHash: string;
  }>();
  protected override transaction<R>(
    fn: (tx: CrudTx) => Promise<R>,
  ): Promise<R> {
    this.platform.assertPlatform();
    return super.transaction(async (tx) => {
      // 固定默认租户记录永不物理删除；目录写入统一锁它，串行校验JSON域名全局唯一。
      const mutex = await this.repos
        .for(SystemTenant)
        .query('t', tx.manager)
        .withDeleted()
        .andWhere('t.id = :id', { id: '1' })
        .setLock('pessimistic_write')
        .getOne();
      if (!mutex) throw crudErrors.badRequest('租户目录尚未初始化');
      return fn(tx);
    });
  }
  async createTenant(body: CreateTenantBody): Promise<CrudRow<SystemTenant>> {
    this.platform.assertPlatform();
    const username = this.system.validateAdmin(
      body.adminUsername,
      body.adminPassword,
    );
    const passwordHash = await this.system.passwordHash(body.adminPassword);
    const result = await this.creation.run({ username, passwordHash }, () =>
      super.add(body.data),
    );
    await this.permission.bumpVersion(result.id);
    return result;
  }
  private async validateTenant(
    data: Partial<SystemTenant>,
    tx: CrudTx,
    existing?: SystemTenant,
  ) {
    const value = Object.assign({}, existing, data);
    if (existing)
      await this.repos
        .for(SystemTenant)
        .query('t', tx.manager)
        .andWhere('t.id = :id', { id: existing.id })
        .setLock('pessimistic_write')
        .getOne();
    const pack = await this.repos
      .for(TenantPackage)
      .query('p', tx.manager)
      .andWhere('p.id = :id', { id: value.packageId })
      .setLock('pessimistic_read')
      .getOne();
    if (
      !pack ||
      (!pack.enabled && (!existing || existing.packageId !== value.packageId))
    )
      throw crudErrors.badRequest('套餐不存在或已停用', [
        { field: 'data.packageId', messages: ['请选择启用的套餐'] },
      ]);
    const domains = value.domains ?? [];
    const tenants = await this.repos
      .for(SystemTenant)
      .query('t', tx.manager)
      .getMany();
    if (
      tenants.some(
        (row) =>
          row.id !== existing?.id &&
          row.domains.some((domain) => domains.includes(domain)),
      )
    )
      throw crudErrors.badRequest('域名已绑定其他租户', [
        { field: 'data.domains', messages: ['域名必须全局唯一'] },
      ]);
    if (
      !existing &&
      pack.quotas.maxUsers !== null &&
      pack.quotas.maxUsers !== undefined &&
      pack.quotas.maxUsers < 1
    )
      throw crudErrors.badRequest('套餐用户数配额不足以创建管理员');
  }
  protected override async beforeAdd(data: Partial<SystemTenant>, tx: CrudTx) {
    data.domains ??= [];
    data.enabled ??= true;
    if (!this.creation.getStore())
      throw crudErrors.badRequest('创建租户必须填写管理员账号和密码');
    await this.validateTenant(data, tx);
  }
  protected override async afterAdd(row: SystemTenant, tx: CrudTx) {
    const admin = this.creation.getStore();
    if (!admin) throw new Error('缺少租户初始化上下文');
    await this.platform.provision(
      row.id,
      '创建租户：初始化组织、管理员角色和账号',
      () =>
        this.system.initialize(
          tx.manager,
          row.name,
          admin.username,
          admin.passwordHash,
        ),
    );
  }
  protected override beforeUpdate(
    data: Partial<SystemTenant>,
    row: SystemTenant,
    tx: CrudTx,
  ) {
    return this.validateTenant(data, tx, row);
  }
  protected override async beforeDelete(rows: SystemTenant[], tx: CrudTx) {
    await this.repos.for(SystemTenant).update(
      rows.map((row) => row.id),
      { enabled: false },
      tx.manager,
    );
  }
  override async update(
    id: string,
    version: number,
    data: Partial<SystemTenant>,
    children?: unknown,
  ) {
    this.platform.assertPlatform();
    const result = await super.update(id, version, data, children);
    await this.permission.bumpVersion(id);
    return result;
  }
  override async delete(ids: string[]) {
    this.platform.assertPlatform();
    const result = await super.delete(ids);
    await Promise.all(ids.map((id) => this.permission.bumpVersion(id)));
    return result;
  }
  async usage(id: string): Promise<TenantUsageResult> {
    this.platform.assertPlatform();
    const tenant = await this.context.run({ tenantId: '0' }, () =>
      this.repos
        .for(SystemTenant)
        .query('t')
        .andWhere('t.id=:id', { id })
        .getOne(),
    );
    if (!tenant) throw crudErrors.notFound();
    const pack = await this.context.run({ tenantId: '0' }, () =>
      this.repos
        .for(TenantPackage)
        .query('p')
        .andWhere('p.id=:id', { id: tenant.packageId })
        .getOne(),
    );
    if (!pack) throw crudErrors.notFound();
    try {
      await this.platformAudit.record({
        action: 'cross-tenant-read',
        userId: this.context.current().userId,
        targetTenantId: id,
        detail: '租户概况：用户数、存储用量和配额',
      });
    } catch {
      throw new BusinessException(
        ErrorCode.ServiceUnavailable,
        '审计日志写入失败，请稍后重试',
        503,
      );
    }
    return this.context.run({ tenantId: id }, async () => ({
      tenantId: id,
      users: await this.system.userCount(),
      storageBytes: String(await this.files.bytes()),
      quotas: pack.quotas,
    }));
  }
}

@Injectable()
export class TenantPackageService extends BaseService<TenantPackage> {
  @Inject(PlatformContext) private readonly platform!: PlatformContext;
  @Inject(TenantRepositoryFactory)
  private readonly repos!: TenantRepositoryFactory;
  @Inject(SystemTenantService) private readonly system!: SystemTenantService;
  @Inject(PermissionService) private readonly permission!: PermissionService;
  protected override async transaction<R>(
    fn: (tx: CrudTx) => Promise<R>,
  ): Promise<R> {
    this.platform.assertPlatform();
    const affected = new Set<string>();
    const result = await super.transaction(async (tx) => {
      const rows = await this.repos
        .for(SystemTenant)
        .query('t', tx.manager)
        .orderBy('t.id', 'ASC')
        .setLock('pessimistic_write')
        .getMany();
      rows.forEach((row) => affected.add(row.id));
      return fn(tx);
    });
    await Promise.all(
      [...affected].map((id) => this.permission.bumpVersion(id)),
    );
    return result;
  }
  private async validatePackage(data: Partial<TenantPackage>, tx: CrudTx) {
    const quotas = Object.assign(new TenantQuotas(), data.quotas);
    if (
      Object.keys(quotas).some(
        (key) => !QUOTA_FIELDS.includes(key as (typeof QUOTA_FIELDS)[number]),
      ) ||
      Object.values(quotas).some(
        (value) =>
          value !== null && (!Number.isSafeInteger(value) || value < 0),
      )
    )
      throw crudErrors.badRequest('配额只能是非负安全整数或null');
    data.quotas = quotas;
    const menus = await this.system.platformMenus(tx.manager),
      map = new Map(menus.map((menu) => [menu.id, menu]));
    const selected = new Set(data.menuIds ?? []);
    for (const id of selected) {
      const menu = map.get(id);
      if (!menu || menu.scope !== 'tenant')
        throw crudErrors.badRequest('套餐只能选择租户可用菜单');
      if (menu.parentId) selected.add(menu.parentId);
    }
    data.menuIds = [...selected];
  }
  protected override beforeAdd(data: Partial<TenantPackage>, tx: CrudTx) {
    return this.validatePackage(data, tx);
  }
  protected override async beforeUpdate(
    data: Partial<TenantPackage>,
    row: TenantPackage,
    tx: CrudTx,
  ) {
    const value = Object.assign({}, row, data);
    await this.validatePackage(value, tx);
    data.menuIds = value.menuIds;
    data.quotas = value.quotas;
  }
  protected override async beforeDelete(rows: TenantPackage[], tx: CrudTx) {
    if (
      await this.repos
        .for(SystemTenant)
        .query('t', tx.manager)
        .andWhere('t.packageId IN (:...ids)', {
          ids: rows.map((row) => row.id),
        })
        .getCount()
    )
      throw crudErrors.badRequest('套餐正在被租户使用，不能删除');
  }
  async menus(): Promise<PackageMenuItem[]> {
    this.platform.assertPlatform();
    const menus = (await this.system.platformMenus()).filter(
      (menu) => menu.scope === 'tenant',
    );
    const build = (
      parentId: string | null,
      seen: Set<string>,
    ): PackageMenuItem[] =>
      menus
        .filter((menu) => menu.parentId === parentId && !seen.has(menu.id))
        .map((menu) => ({
          id: menu.id,
          parentId: menu.parentId,
          type: menu.type,
          title: menu.title,
          permission: menu.permission,
          children: build(menu.id, new Set([...seen, menu.id])),
        }));
    return build(null, new Set());
  }
}
