import { Body, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiExtraModels,
  ApiOkResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { Perms } from '../../../../core/permission/perms.decorator.js';
import { IgnoreTenant } from '../../../../core/endpoint/endpoint.decorators.js';
import { ApiErrors, ApiResult } from '../../../../core/swagger/api-result.js';
import { SystemTenant, TenantPackage } from '../../entity/tenant.entity.js';
import {
  TenantManagementService,
  TenantPackageService,
} from '../../service/tenant-management.service.js';
import { PlatformOnlyGuard } from '../../platform-only.guard.js';
import {
  CreateTenantBody,
  TenantIdBody,
  TenantUsageResult,
  PackageMenuItem,
  TenantCreationResult,
} from '../../dto/tenant.dto.js';

@UseGuards(PlatformOnlyGuard)
@CrudController({
  prefix: 'platform/tenant',
  label: '租户',
  entity: SystemTenant,
  service: TenantManagementService,
  api: ['page', 'info', 'update', 'delete', 'export'],
  pageQuery: {
    keyWords: ['code', 'name'],
    fieldEq: ['code', 'enabled', 'packageId'],
  },
})
export class PlatformTenantController extends BaseController<SystemTenant> {
  constructor(private readonly tenants: TenantManagementService) {
    super();
  }
  @Post('add')
  @HttpCode(200)
  @Perms('platform:tenant:add', { risk: 'high' })
  @ApiOperation({
    operationId: 'platformTenantAdd',
    summary: '创建租户并在同一事务初始化管理员',
  })
  @ApiBody({ type: CreateTenantBody })
  @ApiResult(TenantCreationResult)
  @ApiErrors(400, 403)
  create(@Body() body: CreateTenantBody) {
    return this.tenants.createTenant(body);
  }
  override async schema() {
    const schema = await super.schema();
    schema.api.push('add');
    schema.actions.add = { writable: [...this.service.meta.addable] };
    return schema;
  }
  @Post('usage')
  @HttpCode(200)
  @IgnoreTenant()
  @Perms('platform:tenant:info')
  @ApiOperation({
    operationId: 'platformTenantUsage',
    summary: '只读查看租户用户数、存储与配额',
  })
  @ApiBody({ type: TenantIdBody })
  @ApiResult(TenantUsageResult)
  @ApiErrors(400, 403, 404)
  usage(@Body() body: TenantIdBody) {
    return this.tenants.usage(body.id);
  }
}
@UseGuards(PlatformOnlyGuard)
@CrudController({
  prefix: 'platform/package',
  label: '套餐',
  entity: TenantPackage,
  service: TenantPackageService,
  api: ['page', 'info', 'add', 'update', 'delete', 'export'],
  pageQuery: { keyWords: ['code', 'name'], fieldEq: ['enabled'] },
})
export class PlatformPackageController extends BaseController<TenantPackage> {
  constructor(private readonly packages: TenantPackageService) {
    super();
  }
  @Post('menus')
  @HttpCode(200)
  @Perms('platform:package:info')
  @ApiOperation({
    operationId: 'platformPackageMenus',
    summary: '可选租户菜单树（含按钮）',
  })
  @ApiExtraModels(PackageMenuItem)
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['code', 'data', 'message'],
      properties: {
        code: { type: 'integer', enum: [1000] },
        message: { type: 'string' },
        data: {
          type: 'array',
          items: { $ref: getSchemaPath(PackageMenuItem) },
        },
      },
    },
  })
  @ApiErrors(403)
  menus() {
    return this.packages.menus();
  }
}
