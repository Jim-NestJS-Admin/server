import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemModule } from '../system/system.module.js';
import {
  AiSetting,
  AiTemplate,
  AiTask,
  AiMonthlyUsage,
  AiReconciliation,
} from './entity/ai.entity.js';
import { AiService } from './service/ai.service.js';
import {
  AiSettingsService,
  AiTemplateService,
} from './service/ai-settings.service.js';
import { AiCrypto } from './service/ai-crypto.js';
import { AiProvider, AnthropicProvider } from './service/ai-provider.js';
import { AiWorkerService } from './service/ai-worker.service.js';
import { AiQueueService } from './service/ai-queue.service.js';
import { AiReconciliationService } from './service/ai-reconciliation.service.js';
import { AiReconciliationController } from './controller/admin/ai-reconciliation.controller.js';
import {
  AiConfigController,
  AiTemplateController,
  AiTaskController,
} from './controller/admin/ai.controller.js';
@Module({
  imports: [
    SystemModule,
    TypeOrmModule.forFeature([
      AiSetting,
      AiTemplate,
      AiTask,
      AiMonthlyUsage,
      AiReconciliation,
    ]),
  ],
  controllers: [
    AiConfigController,
    AiTemplateController,
    AiTaskController,
    AiReconciliationController,
  ],
  providers: [
    AiService,
    AiSettingsService,
    AiTemplateService,
    AiCrypto,
    { provide: AiProvider, useClass: AnthropicProvider },
    AiWorkerService,
    AiQueueService,
    AiReconciliationService,
  ],
  exports: [AiService],
})
export class AiModule {}
