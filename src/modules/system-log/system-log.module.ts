import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SYSTEM_LOG_ENTITIES } from './entity/system-log.entity.js';
import {
  SystemDictTypeService,
  SystemDictItemService,
  SystemParameterService,
} from './service/system-settings.service.js';
import {
  SystemAuthEvents,
  SystemCrudAudit,
  SystemOperationRecorder,
} from './service/system-audit.service.js';
import { SystemOperationInterceptor } from './service/system-operation.interceptor.js';
import {
  SystemDictTypeController,
  SystemDictItemController,
  SystemParameterController,
  SystemLoginLogController,
  SystemOperationLogController,
} from './controller/admin/system-log.controller.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature(SYSTEM_LOG_ENTITIES)],
  controllers: [
    SystemDictTypeController,
    SystemDictItemController,
    SystemParameterController,
    SystemLoginLogController,
    SystemOperationLogController,
  ],
  providers: [
    SystemDictTypeService,
    SystemDictItemService,
    SystemParameterService,
    SystemAuthEvents,
    SystemCrudAudit,
    SystemOperationRecorder,
    { provide: APP_INTERCEPTOR, useClass: SystemOperationInterceptor },
  ],
  exports: [SystemAuthEvents, SystemCrudAudit, SystemOperationRecorder],
})
export class SystemLogModule {}
