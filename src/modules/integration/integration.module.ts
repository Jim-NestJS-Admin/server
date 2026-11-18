import { Module } from '@nestjs/common';
import { IntegrationWorkerService } from './service/integration-worker.service.js';
import { WorkflowModule } from '../workflow/workflow.module.js';
import { IntegrationCard } from './entity/integration.entity.js';
import { IntegrationCallbackService } from './service/integration-callback.service.js';
import { IntegrationCallbackController } from './controller/admin/integration-callback.controller.js';
import { IntegrationSyncService } from './service/integration-sync.service.js';
import { IntegrationLoginService } from './service/integration-login.service.js';
import { IntegrationLoginController } from './controller/admin/integration-login.controller.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemModule } from '../system/system.module.js';
import {
  IntegrationApp,
  UserSocial,
  OrgSocial,
  IntegrationInbox,
  IntegrationSyncLog,
} from './entity/integration.entity.js';
import { IntegrationAppService } from './service/integration-app.service.js';
import { IntegrationCrypto } from './service/integration-crypto.js';
import { WecomAdapter } from './service/wecom-adapter.js';
import {
  IntegrationAppController,
  IntegrationSyncLogService,
  IntegrationSyncLogController,
} from './controller/admin/integration.controller.js';
import { IntegrationNotificationChannel } from './service/integration-channel.js';
import { NotificationChannel } from '../notify/service/notify-ports.js';

@Module({
  imports: [
    WorkflowModule,
    SystemModule,
    TypeOrmModule.forFeature([
      IntegrationApp,
      UserSocial,
      OrgSocial,
      IntegrationInbox,
      IntegrationSyncLog,
      IntegrationCard,
    ]),
  ],
  controllers: [
    IntegrationSyncLogController,
    IntegrationCallbackController,
    IntegrationAppController,
    IntegrationLoginController,
  ],
  providers: [
    IntegrationSyncLogService,
    IntegrationWorkerService,
    IntegrationCallbackService,
    IntegrationSyncService,
    IntegrationLoginService,
    IntegrationAppService,
    IntegrationCrypto,
    WecomAdapter,
    { provide: NotificationChannel, useClass: IntegrationNotificationChannel },
  ],
  exports: [NotificationChannel],
})
export class IntegrationModule {}
