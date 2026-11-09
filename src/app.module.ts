import { Module } from '@nestjs/common';
import { resolve } from 'node:path';
import { FileModule } from './modules/file/file.module.js';
import { LocalBlobStore } from './modules/file/storage/local.store.js';
import { AuthModule } from './core/auth/auth.module.js';
import { CoreModule } from './core/core.module.js';
import { PreferenceModule } from './core/preference/preference.controller.js';
import { PageConfigModule } from './core/page-config/page-config.module.js';
import { ConditionalModule } from '@nestjs/config';
import { CodegenModule } from './modules/codegen/codegen.module.js';
import { PermissionModule } from './core/permission/permission.module.js';
import { SystemModule } from './modules/system/system.module.js';
import { SystemFieldSource } from './modules/system/service/system-field.source.js';
import { SystemLogModule } from './modules/system-log/system-log.module.js';
import { SystemAuthEvents } from './modules/system-log/service/system-audit.service.js';
import {
  SystemAuthUserStore,
  SystemPermissionSource,
} from './modules/system/service/system-auth.adapters.js';

@Module({
  imports: [
    CoreModule,
    FileModule.register({
      store: new LocalBlobStore(resolve(process.cwd(), 'deploy/data/files')),
      policy: {
        maxBytes: 10 * 1024 * 1024,
        mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
      },
      access: 'session',
      catalog: 'database',
    }),
    AuthModule.forRoot({
      userStore: SystemAuthUserStore,
      events: SystemAuthEvents,
      imports: [SystemModule, SystemLogModule],
    }),
    PermissionModule.forRoot({
      source: SystemPermissionSource,
      fieldSource: SystemFieldSource,
      imports: [SystemModule],
    }),
    PreferenceModule,
    PageConfigModule,
    // 代码生成只在开发环境、且明确打开时装配；生产环境整个模块不存在（T21）
    ConditionalModule.registerWhen(
      CodegenModule,
      (env) => env.NODE_ENV === 'development' && env.CODEGEN_ENABLED === 'true',
    ),
  ],
})
export class AppModule {}
