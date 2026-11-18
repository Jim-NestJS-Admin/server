import { Module } from '@nestjs/common';
import { IntegrationModule } from '../integration/integration.module.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemModule } from '../system/system.module.js';
import { WorkflowModule } from '../workflow/workflow.module.js';
import {
  NotifyMessage,
  NotifyDelivery,
  NotifyReceipt,
} from './entity/notify.entity.js';
import { NotifyMessageController } from './controller/admin/notify.controller.js';
import { NotifyMessageService } from './service/notify.service.js';
import { NotifyWorkerService } from './service/notify-worker.service.js';
import { NotificationBusinessRegistry } from './service/notify-ports.js';
import { NotifySecurityService } from './service/notify-security.service.js';

@Module({
  imports: [
    IntegrationModule,
    SystemModule,
    WorkflowModule,
    TypeOrmModule.forFeature([NotifyMessage, NotifyDelivery, NotifyReceipt]),
  ],
  controllers: [NotifyMessageController],
  providers: [
    NotifyMessageService,
    NotifyWorkerService,
    NotificationBusinessRegistry,
    NotifySecurityService,
  ],
  exports: [NotificationBusinessRegistry, NotifySecurityService],
})
export class NotifyModule {}
