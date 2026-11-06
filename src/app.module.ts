import { Module } from '@nestjs/common';
import { resolve } from 'node:path';
import { FileModule } from './modules/file/file.module.js';
import { LocalBlobStore } from './modules/file/storage/local.store.js';
import { AuthModule } from './core/auth/auth.module.js';
import { CoreModule } from './core/core.module.js';
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
  ],
})
export class AppModule {}
