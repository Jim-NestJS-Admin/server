import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SYSTEM_ENTITIES } from './entity/system.entity.js';
import { SystemDirectory } from './service/system-directory.service.js';

@Module({
  imports: [TypeOrmModule.forFeature(SYSTEM_ENTITIES)],
  providers: [SystemDirectory],
  exports: [SystemDirectory],
})
export class SystemModule {}
