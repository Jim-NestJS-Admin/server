import { Module } from '@nestjs/common';
import { AuthModule } from './core/auth/auth.module.js';
import { CoreModule } from './core/core.module.js';
import { PermissionModule } from './core/permission/permission.module.js';
import { SystemModule } from './modules/system/system.module.js';
import {
  SystemAuthUserStore,
  SystemPermissionSource,
} from './modules/system/service/system-auth.adapters.js';

@Module({
  imports: [
    CoreModule,
    AuthModule.forRoot({
      userStore: SystemAuthUserStore,
      imports: [SystemModule],
    }),
    PermissionModule.forRoot({
      source: SystemPermissionSource,
      imports: [SystemModule],
    }),
  ],
})
export class AppModule {}
