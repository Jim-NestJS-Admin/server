import { CrudController } from '../../../../core/crud/crud-controller.decorator.js';
import { Body, Post, HttpCode, Get, Query } from '@nestjs/common';
import { SystemFieldOverview } from '../../service/system-field.overview.js';
import {
  RoleFieldOverviewQuery,
  FieldConfigurationOverview,
} from '../../dto/system-field.dto.js';
import { ApiOperation, ApiBody } from '@nestjs/swagger';
import { ApiResult, ApiErrors } from '../../../../core/swagger/api-result.js';
import {
  SaveFieldConfigurations,
  SaveRoleFieldConfigurations,
  FieldConfigurationResult,
} from '../../dto/system-field.dto.js';
import { BaseController } from '../../../../core/crud/base.controller.js';
import { Perms } from '../../../../core/permission/perms.decorator.js';
import {
  SystemField,
  SystemRoleField,
} from '../../entity/system-field.entity.js';
import {
  SystemFieldService,
  SystemRoleFieldService,
} from '../../service/system-field.service.js';

function securityWrites(prefix: string): ClassDecorator {
  return (target) => {
    for (const method of ['add', 'update', 'delete']) {
      const descriptor = Object.getOwnPropertyDescriptor(
        target.prototype,
        method,
      );
      if (descriptor)
        Perms(`${prefix}:${method}`, { risk: 'high' })(
          target.prototype,
          method,
          descriptor,
        );
    }
  };
}
@securityWrites('system:field')
@CrudController({
  prefix: 'system/field',
  label: '模块字段默认权限',
  entity: SystemField,
  service: SystemFieldService,
  api: ['page', 'info', 'add', 'update', 'delete'],
  pageQuery: {
    keyWords: ['resource', 'field'],
    fieldEq: ['resource', 'field', 'enabled'],
  },
})
export class SystemFieldController extends BaseController<SystemField> {
  constructor(
    private readonly fields: SystemFieldService,
    private readonly overview: SystemFieldOverview,
  ) {
    super();
  }
  @Get('overview')
  @Perms('system:field:page')
  @ApiOperation({
    operationId: 'systemFieldOverview',
    summary: '合并代码与当前租户模块字段默认配置',
  })
  @ApiResult(FieldConfigurationOverview)
  @ApiErrors(401, 403)
  readOverview() {
    return this.overview.read();
  }
  @Post('save')
  @HttpCode(200)
  @Perms('system:field:update', { risk: 'high' })
  @ApiOperation({
    operationId: 'systemFieldSave',
    summary: '同事务保存模块字段默认权限',
  })
  @ApiBody({ type: SaveFieldConfigurations })
  @ApiResult(FieldConfigurationResult)
  @ApiErrors(400, 403, 409)
  save(@Body() body: SaveFieldConfigurations) {
    return this.fields.saveConfigurations(body.changes);
  }
}

@securityWrites('system:role-field')
@CrudController({
  prefix: 'system/role-field',
  label: '角色字段权限',
  entity: SystemRoleField,
  service: SystemRoleFieldService,
  api: ['page', 'info', 'add', 'update', 'delete'],
  pageQuery: {
    keyWords: ['resource', 'field'],
    fieldEq: ['roleId', 'resource', 'field'],
  },
})
export class SystemRoleFieldController extends BaseController<SystemRoleField> {
  constructor(
    private readonly fields: SystemRoleFieldService,
    private readonly overview: SystemFieldOverview,
  ) {
    super();
  }
  @Get('overview')
  @Perms('system:role-field:page')
  @ApiOperation({
    operationId: 'systemRoleFieldOverview',
    summary: '角色字段权限与模块默认的配置读模型',
  })
  @ApiResult(FieldConfigurationOverview)
  @ApiErrors(400, 401, 403)
  readOverview(@Query() query: RoleFieldOverviewQuery) {
    return this.overview.read(query.roleId);
  }
  @Post('save')
  @HttpCode(200)
  @Perms('system:role-field:update', { risk: 'high' })
  @ApiOperation({
    operationId: 'systemRoleFieldSave',
    summary: '同事务保存角色字段权限，支持整模块和复制后的变更',
  })
  @ApiBody({ type: SaveRoleFieldConfigurations })
  @ApiResult(FieldConfigurationResult)
  @ApiErrors(400, 403, 409)
  save(@Body() body: SaveRoleFieldConfigurations) {
    return this.fields.saveConfigurations(body.changes, body.roleId);
  }
}
