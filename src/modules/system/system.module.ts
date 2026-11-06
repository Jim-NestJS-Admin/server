import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SYSTEM_ENTITIES } from './entity/system.entity.js';
import { SystemDirectory } from './service/system-directory.service.js';
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
  imports: [TypeOrmModule.forFeature(SYSTEM_ENTITIES)],
  providers: [
    SystemDirectory,
    SystemUserService,
    SystemRoleService,
    SystemOrgService,
    SystemMenuService,
    SystemUserRoleService,
    SystemSupervisorService,
  ],
  controllers: [
    SystemUserController,
    SystemRoleController,
    SystemOrgController,
    SystemMenuController,
    SystemUserRoleController,
    SystemSupervisorController,
    SystemPermissionController,
  ],
  exports: [SystemDirectory],
})
export class SystemModule {}
