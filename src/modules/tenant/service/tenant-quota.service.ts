import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../core/exceptions/error-code.js';
import { SystemTenantService } from '../../system/service/system-tenant.service.js';
import { FileUsageService } from '../../file/service/file-usage.service.js';
import { SystemTenant, TenantPackage } from '../entity/tenant.entity.js';

/** 所有写入口在同一业务事务内先锁租户行、再读最新用量，避免并发穿透。 */
@Injectable()
export class TenantQuotaService {
  constructor(
    private readonly source: DataSource,
    private readonly context: RequestContext,
    private readonly repos: TenantRepositoryFactory,
    private readonly system: SystemTenantService,
    private readonly files: FileUsageService,
  ) {}
  private async quota(tenantId: string, manager: EntityManager) {
    if (this.context.current().tenantId !== tenantId)
      throw new BusinessException(ErrorCode.Forbidden, '租户上下文不一致', 403);
    return this.context.run({ tenantId: '0' }, async () => {
      const tenant = await this.repos
        .for(SystemTenant)
        .query('t', manager)
        .andWhere('t.id=:id', { id: tenantId })
        .setLock('pessimistic_write')
        .getOne();
      if (
        !tenant ||
        !tenant.enabled ||
        (tenant.expiresAt && tenant.expiresAt.getTime() <= Date.now())
      )
        throw crudErrors.badRequest('租户不可用');
      const pack = await this.repos
        .for(TenantPackage)
        .query('p', manager)
        .andWhere('p.id=:id', { id: tenant.packageId })
        .getOne();
      if (!pack) throw crudErrors.badRequest('租户套餐不可用');
      return pack.quotas;
    });
  }
  async assertCanAddUser(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<void> {
    if (this.context.current().tenantId !== tenantId)
      throw new BusinessException(ErrorCode.Forbidden, '租户上下文不一致', 403);
    if (tenantId === '0') return;
    if (!manager)
      return this.source.transaction((tx) =>
        this.assertCanAddUser(tenantId, tx),
      );
    if (!manager.queryRunner?.isTransactionActive)
      throw new Error('配额检查必须在事务内');
    const quota = await this.quota(tenantId, manager);
    if (
      quota.maxUsers !== null &&
      quota.maxUsers !== undefined &&
      (await this.system.userCount(manager)) >= quota.maxUsers
    )
      throw crudErrors.badRequest('已达到套餐的用户数上限');
  }
  async assertStorage(
    tenantId: string,
    addBytes: number,
    manager?: EntityManager,
  ): Promise<void> {
    if (this.context.current().tenantId !== tenantId)
      throw new BusinessException(ErrorCode.Forbidden, '租户上下文不一致', 403);
    if (!Number.isSafeInteger(addBytes) || addBytes < 0)
      throw crudErrors.badRequest('文件大小不合法');
    if (tenantId === '0') return;
    if (!manager)
      return this.source.transaction((tx) =>
        this.assertStorage(tenantId, addBytes, tx),
      );
    if (!manager.queryRunner?.isTransactionActive)
      throw new Error('配额检查必须在事务内');
    const quota = await this.quota(tenantId, manager);
    if (
      quota.storageMb !== null &&
      quota.storageMb !== undefined &&
      (await this.files.bytes(manager)) + BigInt(addBytes) >
        BigInt(quota.storageMb) * 1048576n
    )
      throw crudErrors.badRequest('已达到套餐的存储空间上限');
  }
}
