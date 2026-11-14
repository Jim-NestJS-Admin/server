import { FormSubmission } from './entity/form-submission.entity.js';
import { FormSubmissionService } from './service/form-submission.service.js';
import { FormSubmissionController } from './controller/admin/form-submission.controller.js';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FormDefinition } from './entity/form-definition.entity.js';
import { FormDefinitionService } from './service/form-definition.service.js';
import { FormDefinitionController } from './controller/admin/form-definition.controller.js';
import { SystemModule } from '../system/system.module.js';

@Module({
  imports: [
    SystemModule,
    TypeOrmModule.forFeature([FormDefinition, FormSubmission]),
  ],
  providers: [FormDefinitionService, FormSubmissionService],
  controllers: [FormDefinitionController, FormSubmissionController],
  exports: [FormDefinitionService, FormSubmissionService],
})
export class FormModule {}
