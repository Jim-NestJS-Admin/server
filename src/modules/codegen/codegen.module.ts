import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CodegenController } from './codegen.controller.js';
import { CodegenEntity } from './codegen.entity.js';
import { CodegenService } from './codegen.service.js';

/** 代码生成（T21）。只由 AppModule 在「开发环境 + CODEGEN_ENABLED=true」时装配 */
@Module({
  imports: [TypeOrmModule.forFeature([CodegenEntity])],
  controllers: [CodegenController],
  providers: [CodegenService],
})
export class CodegenModule {}
