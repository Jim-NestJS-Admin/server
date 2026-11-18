import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OAuthModule } from '../oauth/oauth.module.js';
import { SystemModule } from '../system/system.module.js';
import { NotifyModule } from '../notify/notify.module.js';
import { TenantQuotaModule } from '../tenant/tenant-quota.module.js';
import {
  McpSetting,
  McpOperation,
  McpUsage,
  McpEvent,
  McpExempt,
  McpApprover,
} from './entity/mcp.entity.js';
import { McpService } from './service/mcp.service.js';
import { McpRuntimeService } from './service/mcp-runtime.service.js';
import { McpOperationListService } from './service/mcp-operation-list.service.js';
import { McpOperationListController } from './controller/admin/mcp-operation-list.controller.js';
import {
  McpOperationController,
  McpConfigController,
  McpEventController,
} from './controller/admin/mcp.controller.js';
@Module({
  imports: [
    OAuthModule,
    SystemModule,
    NotifyModule,
    TenantQuotaModule,
    TypeOrmModule.forFeature([
      McpSetting,
      McpOperation,
      McpUsage,
      McpEvent,
      McpExempt,
      McpApprover,
    ]),
  ],
  providers: [McpService, McpRuntimeService, McpOperationListService],
  controllers: [
    McpOperationController,
    McpConfigController,
    McpEventController,
    McpOperationListController,
  ],
  exports: [McpRuntimeService],
})
export class McpModule {}
