import { UseGuards } from '@nestjs/common';
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { FileAssetEntity } from '../../entity/file-asset.entity.js';
import { FileGuard, FileOperation } from '../../file.guard.js';
import { FileAssetService } from '../../service/file-asset.service.js';

/** 元数据只开放分页/详情，上传下载走自定义接口；动作和数据范围均由core授权。 */
@UseGuards(FileGuard)
@FileOperation('read')
@CrudController({
  prefix: 'file/asset',
  label: '文件',
  entity: FileAssetEntity,
  api: ['page', 'info'],
  service: FileAssetService,
  dataScope: true,
})
export class FileAssetController extends BaseController<FileAssetEntity> {}
