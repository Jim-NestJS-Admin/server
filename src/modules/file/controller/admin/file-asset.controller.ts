import { UseGuards } from '@nestjs/common';
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { FileAssetEntity } from '../../entity/file-asset.entity.js';
import { FileGuard, FileOperation } from '../../file.guard.js';
import { FileAssetService } from '../../service/file-asset.service.js';

/** 元数据只开放分页/详情，上传下载走自定义接口；正式权限接入前继续默认拒绝。 */
@UseGuards(FileGuard)
@FileOperation('read')
@CrudController({
  prefix: 'file/asset',
  label: '文件',
  entity: FileAssetEntity,
  api: ['page', 'info'],
  service: FileAssetService,
})
export class FileAssetController extends BaseController<FileAssetEntity> {}
