import { BaseController } from '../../../../core/crud/base.controller.js';
import { Get, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { LoginOnly } from '../../../../core/permission/perms.decorator.js';
import { ApiResult } from '../../../../core/swagger/api-result.js';
import { CrudController } from '../../../../core/crud/crud-controller.decorator.js';
import {
  SystemDictType,
  SystemDictItem,
  SystemParameter,
  SystemLoginLog,
  SystemOperationLog,
} from '../../entity/system-log.entity.js';
import {
  SystemDictTypeService,
  SystemDictItemService,
  SystemParameterService,
} from '../../service/system-settings.service.js';

class DictionaryQuery {
  @ApiProperty() @Matches(/^[a-z][a-z0-9_.-]{1,63}$/) code: string;
}
class DictionaryOption {
  @ApiProperty() value: string;
  @ApiProperty() label: string;
}
class DictionaryOptions {
  @ApiProperty({ type: [DictionaryOption] }) items: DictionaryOption[];
}

@CrudController({
  prefix: 'system/dict-type',
  label: '字典类型',
  entity: SystemDictType,
  service: SystemDictTypeService,
  api: ['page', 'info', 'add', 'update', 'delete'],
  pageQuery: { keyWords: ['code', 'name'], fieldEq: ['enabled'] },
})
export class SystemDictTypeController extends BaseController<SystemDictType> {
  constructor(private readonly dictionaries: SystemDictTypeService) {
    super();
  }
  @Get('data')
  @LoginOnly()
  @ApiResult(DictionaryOptions)
  @ApiOperation({
    operationId: 'systemDictionaryOptions',
    summary: '当前租户启用字典的下拉选项',
  })
  options(@Query() query: DictionaryQuery) {
    return this.dictionaries.items(query.code);
  }
}
@CrudController({
  prefix: 'system/dict-item',
  label: '字典项',
  entity: SystemDictItem,
  service: SystemDictItemService,
  api: ['page', 'info', 'add', 'update', 'delete'],
  pageQuery: {
    keyWords: ['label', 'value'],
    fieldEq: ['typeId', 'enabled'],
    defaultSort: [{ field: 'rank', order: 'asc' }],
  },
})
export class SystemDictItemController extends BaseController<SystemDictItem> {}
@CrudController({
  prefix: 'system/parameter',
  label: '系统参数',
  entity: SystemParameter,
  service: SystemParameterService,
  api: ['page', 'info', 'add', 'update', 'delete'],
  pageQuery: { keyWords: ['key'] },
})
export class SystemParameterController extends BaseController<SystemParameter> {}
@CrudController({
  prefix: 'system/login-log',
  label: '登录日志',
  entity: SystemLoginLog,
  api: ['page', 'info'],
  pageQuery: { keyWords: ['username'], fieldEq: ['event', 'success'] },
})
export class SystemLoginLogController extends BaseController<SystemLoginLog> {}
@CrudController({
  prefix: 'system/operation-log',
  label: '操作日志',
  entity: SystemOperationLog,
  api: ['page', 'info'],
  pageQuery: { keyWords: ['action', 'resource'], fieldEq: ['success'] },
})
export class SystemOperationLogController extends BaseController<SystemOperationLog> {}
