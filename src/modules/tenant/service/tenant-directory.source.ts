import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import {
  TenantSource,
  type TenantInfo,
} from '../../../core/tenant/tenant-source.js';
import {
  SystemTenant,
  TenantPackage,
  normalizeTenantDomain,
} from '../entity/tenant.entity.js';

const PLATFORM: TenantInfo = Object.freeze({
  id: '0',
  code: 'platform',
  name: '平台',
  enabled: true,
  packageId: null,
});

/** 只读平台租户目录。无缓存，每次读取当前停用/到期/套餐状态，不保留过期的授权信息。 */
@Injectable()
export class TenantDirectorySource extends TenantSource {
  async activeTenantIds(): Promise<string[]> {
    return this.catalog(async () =>
      (
        await this.repos.for(SystemTenant).query('t').select(['t.id']).getMany()
      ).map((row) => row.id),
    );
  }
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
  ) {
    super();
  }
  private catalog<R>(read: () => Promise<R>): Promise<R> {
    // 登录前也要查平台目录；此入口只包裹本模块自有表的只读查询，绝不执行写入。
    return this.context.run({ tenantId: '0' }, read);
  }
  private info(row: SystemTenant | null): TenantInfo | null {
    return row
      ? {
          id: row.id,
          code: row.code,
          name: row.name,
          enabled:
            row.enabled &&
            (!row.expiresAt || row.expiresAt.getTime() > Date.now()),
          packageId: row.packageId,
        }
      : null;
  }
  async byId(id: string): Promise<TenantInfo | null> {
    if (id === '0') return { ...PLATFORM };
    if (!/^[1-9]\d{0,19}$/.test(id)) return null;
    return this.catalog(async () =>
      this.info(
        await this.repos
          .for(SystemTenant)
          .query('t')
          .andWhere('t.id = :id', { id })
          .getOne(),
      ),
    );
  }
  async byCode(code: string): Promise<TenantInfo | null> {
    if (code === 'platform') return { ...PLATFORM };
    return this.catalog(async () =>
      this.info(
        await this.repos
          .for(SystemTenant)
          .query('t')
          .andWhere('t.code = :code', { code })
          .getOne(),
      ),
    );
  }
  async byDomain(host: string): Promise<TenantInfo | null> {
    const domain = normalizeTenantDomain(host);
    if (!domain) return null;
    return this.catalog(async () =>
      this.info(
        await this.repos
          .for(SystemTenant)
          .query('t')
          .andWhere('JSON_CONTAINS(t.domains, :domain)', {
            domain: JSON.stringify(domain),
          })
          .getOne(),
      ),
    );
  }
  async packageMenuIds(tenantId: string): Promise<string[] | null> {
    if (tenantId === '0') return null;
    return this.catalog(async () => {
      const tenant = await this.repos
        .for(SystemTenant)
        .query('t')
        .andWhere('t.id = :id', { id: tenantId })
        .getOne();
      if (!this.info(tenant)?.enabled) return [];
      const pack = await this.repos
        .for(TenantPackage)
        .query('p')
        .andWhere('p.id = :id', { id: tenant!.packageId })
        .getOne();
      // 停用套餐不影响已有租户；套餐缺失/删除则收窄为无权限，不能返回不限。
      return pack ? [...pack.menuIds] : [];
    });
  }
}
