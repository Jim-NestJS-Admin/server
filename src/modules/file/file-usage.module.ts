import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileAssetEntity } from './entity/file-asset.entity.js';
import { FileUsageService } from './service/file-usage.service.js';
@Module({
  imports: [TypeOrmModule.forFeature([FileAssetEntity])],
  providers: [FileUsageService],
  exports: [FileUsageService],
})
export class FileUsageModule {}
