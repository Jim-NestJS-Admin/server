import { Module } from '@nestjs/common';
import { TenantDirectoryModule } from './tenant-directory.module.js';
import { TenantQuotaModule } from './tenant-quota.module.js';
import { SystemTenantModule } from '../system/system-tenant.module.js';
import { FileUsageModule } from '../file/file-usage.module.js';
import {
  TenantManagementService,
  TenantPackageService,
} from './service/tenant-management.service.js';
import {
  PlatformTenantController,
  PlatformPackageController,
} from './controller/admin/tenant.controller.js';
import { PlatformOnlyGuard } from './platform-only.guard.js';
import { TenantSeedService } from './service/tenant-seed.service.js';
@Module({
  imports: [
    TenantDirectoryModule,
    TenantQuotaModule,
    SystemTenantModule,
    FileUsageModule,
  ],
  providers: [
    TenantManagementService,
    TenantPackageService,
    PlatformOnlyGuard,
    TenantSeedService,
  ],
  controllers: [PlatformTenantController, PlatformPackageController],
  exports: [TenantSeedService],
})
export class TenantModule {}
