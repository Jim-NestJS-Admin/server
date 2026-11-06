import { Module } from '@nestjs/common';
import { AuthModule } from './core/auth/auth.module.js';
import { CoreModule } from './core/core.module.js';
import { PermissionModule } from './core/permission/permission.module.js';

@Module({
  // T07 接入后：
  //   AuthModule.forRoot({ userStore: SystemAuthUserStore, imports: [SystemModule] })
  //   PermissionModule.forRoot({ source: SystemPermissionSource, imports: [SystemModule] })
  imports: [CoreModule, AuthModule.forRoot(), PermissionModule.forRoot()],
})
export class AppModule {}
