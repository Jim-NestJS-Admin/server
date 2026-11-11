import { Global, Module } from '@nestjs/common';
import { TenantDirectoryModule } from './tenant-directory.module.js';
import { TenantQuotaService } from './service/tenant-quota.service.js';
import { SystemTenantModule } from '../system/system-tenant.module.js';
import { FileUsageModule } from '../file/file-usage.module.js';
@Global()
@Module({
  imports: [TenantDirectoryModule, SystemTenantModule, FileUsageModule],
  providers: [TenantQuotaService],
  exports: [TenantQuotaService],
})
export class TenantQuotaModule {}
