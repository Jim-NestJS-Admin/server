import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SYSTEM_ENTITIES } from './entity/system.entity.js';
import { SystemTenantService } from './service/system-tenant.service.js';
@Module({
  imports: [TypeOrmModule.forFeature(SYSTEM_ENTITIES)],
  providers: [SystemTenantService],
  exports: [SystemTenantService],
})
export class SystemTenantModule {}
