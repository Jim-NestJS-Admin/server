import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FormModule } from '../form/form.module.js';
import { SystemModule } from '../system/system.module.js';
import { WorkflowDefinition } from './entity/workflow-definition.entity.js';
import { WorkflowDefinitionService } from './service/workflow-definition.service.js';
import { WorkflowDefinitionController } from './controller/admin/workflow-definition.controller.js';

@Module({
  imports: [
    FormModule,
    SystemModule,
    TypeOrmModule.forFeature([WorkflowDefinition]),
  ],
  providers: [WorkflowDefinitionService],
  controllers: [WorkflowDefinitionController],
  exports: [WorkflowDefinitionService],
})
export class WorkflowModule {}
