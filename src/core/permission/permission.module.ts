import {
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type Type,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AdminAuthorizer } from '../endpoint/endpoint-auth.js';
import { MenuController } from './controller/admin/menu.controller.js';
import { PermissionAuthorizer } from './permission.authorizer.js';
import { PermissionRegistry } from './permission-registry.js';
import {
  PermissionSource,
  UnconfiguredPermissionSource,
} from './permission-source.js';
import { PermissionService } from './permission.service.js';

export interface PermissionModuleOptions {
  /** 角色、组织、菜单的读取实现，system 模块（T07）提供；不传时没有任何角色（生产环境启动失败） */
  source?: Type<PermissionSource>;
  imports?: ModuleMetadata['imports'];
}

/**
 * 权限（T06）：@Perms / @LoginOnly、权限守卫、本次有效角色、数据范围、权限缓存、菜单。
 * 在 AppModule 里 `PermissionModule.forRoot({ source: ..., imports: [SystemModule] })`。
 */
@Module({})
export class PermissionModule {
  static forRoot(options: PermissionModuleOptions = {}): DynamicModule {
    return {
      module: PermissionModule,
      global: true,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      controllers: [MenuController],
      providers: [
        PermissionRegistry,
        PermissionService,
        { provide: AdminAuthorizer, useClass: PermissionAuthorizer },
        {
          provide: PermissionSource,
          useClass: options.source ?? UnconfiguredPermissionSource,
        },
      ],
      exports: [
        AdminAuthorizer,
        PermissionService,
        PermissionRegistry,
        PermissionSource,
      ],
    };
  }
}
