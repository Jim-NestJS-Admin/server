import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemTenant, TenantPackage } from './entity/tenant.entity.js';
import { TenantDirectorySource } from './service/tenant-directory.source.js';

/** 仅目录读取，不依赖system/file业务模块，供TenantCoreModule的source装配。 */
@Module({
  imports: [TypeOrmModule.forFeature([SystemTenant, TenantPackage])],
  providers: [TenantDirectorySource],
  exports: [TenantDirectorySource, TypeOrmModule],
})
export class TenantDirectoryModule {}
