import { Module } from '@nestjs/common';
import { WorkflowDirectoryController } from './controller/admin/workflow-directory.controller.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FormModule } from '../form/form.module.js';
import { SystemModule } from '../system/system.module.js';
import { WorkflowDefinition } from './entity/workflow-definition.entity.js';
import { WorkflowDefinitionService } from './service/workflow-definition.service.js';
import { WorkflowDefinitionController } from './controller/admin/workflow-definition.controller.js';
import { WORKFLOW_RUNTIME_ENTITIES } from './entity/workflow-runtime.entity.js';
import { FileUsageModule } from '../file/file-usage.module.js';
import { WorkflowTimer } from './entity/workflow-timer.entity.js';
import { WorkflowTimerService } from './service/workflow-timer.service.js';
import { WorkflowPlanner } from './service/workflow-plan.js';
import { WorkflowRuntimeService } from './service/workflow-runtime.service.js';
import {
  WorkflowInstanceService,
  WorkflowTaskService,
  WorkflowRecordService,
} from './service/workflow-runtime-views.service.js';
import {
  WorkflowInstanceController,
  WorkflowTaskController,
  WorkflowRecordController,
} from './controller/admin/workflow-runtime.controller.js';

@Module({
  imports: [
    FormModule,
    FileUsageModule,
    SystemModule,
    TypeOrmModule.forFeature([
      WorkflowDefinition,
      WorkflowTimer,
      ...WORKFLOW_RUNTIME_ENTITIES,
    ]),
  ],
  providers: [
    WorkflowDefinitionService,
    WorkflowPlanner,
    WorkflowTimerService,
    WorkflowRuntimeService,
    WorkflowInstanceService,
    WorkflowTaskService,
    WorkflowRecordService,
  ],
  controllers: [
    WorkflowDirectoryController,
    WorkflowDefinitionController,
    WorkflowInstanceController,
    WorkflowTaskController,
    WorkflowRecordController,
  ],
  exports: [WorkflowDefinitionService, WorkflowRuntimeService],
})
export class WorkflowModule {}
