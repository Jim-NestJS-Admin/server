import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PageConfigController } from './page-config.controller.js';
import {
  PageConfigEntity,
  PageConfigHistoryEntity,
} from './page-config.entity.js';
import { PageConfigService, PageViewSource } from './page-config.service.js';

/** 在线页面配置（T23）。PageViewSource 给通用 CRUD 的页面描述合并生效配置 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([PageConfigEntity, PageConfigHistoryEntity]),
  ],
  controllers: [PageConfigController],
  providers: [
    PageConfigService,
    { provide: PageViewSource, useExisting: PageConfigService },
  ],
  exports: [PageViewSource],
})
export class PageConfigModule {}
