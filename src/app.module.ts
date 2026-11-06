import { Module } from '@nestjs/common';
import { AuthModule } from './core/auth/auth.module.js';
import { CoreModule } from './core/core.module.js';
import { PreferenceModule } from './core/preference/preference.controller.js';
import { PageConfigModule } from './core/page-config/page-config.module.js';
import { ConditionalModule } from '@nestjs/config';
import { CodegenModule } from './modules/codegen/codegen.module.js';
import { PermissionModule } from './core/permission/permission.module.js';

@Module({
  // T07 接入后：
  //   AuthModule.forRoot({ userStore: SystemAuthUserStore, imports: [SystemModule] })
  //   PermissionModule.forRoot({ source: SystemPermissionSource, imports: [SystemModule] })
  imports: [
    CoreModule,
    AuthModule.forRoot(),
    PermissionModule.forRoot(),
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
