import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SYSTEM_ENTITIES } from './entity/system.entity.js';
import { SystemField, SystemRoleField } from './entity/system-field.entity.js';
import { SystemFieldCatalog } from './service/system-field.catalog.js';
import { SystemFieldOverview } from './service/system-field.overview.js';
import {
  SystemFieldService,
  SystemRoleFieldService,
} from './service/system-field.service.js';
import {
  SystemFieldController,
  SystemRoleFieldController,
} from './controller/admin/system-field.controller.js';
import { SystemDirectory } from './service/system-directory.service.js';
import { SystemDisplaySource } from './service/system-display.source.js';
import {
  SystemUserService,
  SystemRoleService,
  SystemOrgService,
  SystemMenuService,
  SystemUserRoleService,
  SystemSupervisorService,
} from './service/system-management.service.js';
import {
  SystemUserController,
  SystemRoleController,
  SystemOrgController,
  SystemMenuController,
  SystemUserRoleController,
  SystemSupervisorController,
  SystemPermissionController,
} from './controller/admin/system.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ...SYSTEM_ENTITIES,
      SystemField,
      SystemRoleField,
    ]),
  ],
  providers: [
    SystemFieldCatalog,
    SystemFieldOverview,
    SystemFieldService,
    SystemRoleFieldService,
    SystemDirectory,
    SystemDisplaySource,
    SystemUserService,
    SystemRoleService,
    SystemOrgService,
    SystemMenuService,
    SystemUserRoleService,
    SystemSupervisorService,
  ],
  controllers: [
    SystemFieldController,
    SystemRoleFieldController,
    SystemUserController,
    SystemRoleController,
    SystemOrgController,
    SystemMenuController,
    SystemUserRoleController,
    SystemSupervisorController,
    SystemPermissionController,
  ],
  exports: [SystemDirectory, SystemFieldCatalog],
})
export class SystemModule {}
