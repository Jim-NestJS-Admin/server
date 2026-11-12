import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FormDefinition } from './entity/form-definition.entity.js';
import { FormDefinitionService } from './service/form-definition.service.js';
import { FormDefinitionController } from './controller/admin/form-definition.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([FormDefinition])],
  providers: [FormDefinitionService],
  controllers: [FormDefinitionController],
  exports: [FormDefinitionService],
})
export class FormModule {}
