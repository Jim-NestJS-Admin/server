import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FormModule } from '../form/form.module.js';
import { SystemModule } from '../system/system.module.js';
import { WorkflowDefinition } from './entity/workflow-definition.entity.js';
import { WorkflowDefinitionService } from './service/workflow-definition.service.js';
import { WorkflowDefinitionController } from './controller/admin/workflow-definition.controller.js';
import { WORKFLOW_RUNTIME_ENTITIES } from './entity/workflow-runtime.entity.js';
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
    SystemModule,
    TypeOrmModule.forFeature([
      WorkflowDefinition,
      ...WORKFLOW_RUNTIME_ENTITIES,
    ]),
  ],
  providers: [
    WorkflowDefinitionService,
    WorkflowRuntimeService,
    WorkflowInstanceService,
    WorkflowTaskService,
    WorkflowRecordService,
  ],
  controllers: [
    WorkflowDefinitionController,
    WorkflowInstanceController,
    WorkflowTaskController,
    WorkflowRecordController,
  ],
  exports: [WorkflowDefinitionService],
})
export class WorkflowModule {}
