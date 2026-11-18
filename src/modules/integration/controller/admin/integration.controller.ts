import { Body, HttpCode, Post, Injectable } from '@nestjs/common';
import { BaseService } from '../../../../core/crud/base.service.js';
import { ApiBody, ApiOperation } from '@nestjs/swagger';
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { Perms } from '../../../../core/permission/perms.decorator.js';
import { ApiResult } from '../../../../core/swagger/api-result.js';
import {
  IntegrationApp,
  IntegrationSyncLog,
} from '../../entity/integration.entity.js';
import { IntegrationAppService } from '../../service/integration-app.service.js';
import { IntegrationSyncService } from '../../service/integration-sync.service.js';
import { IntegrationIdBody } from '../../dto/integration.dto.js';
import { crudErrors } from '../../../../core/crud/crud.errors.js';
import {
  IntegrationSaveBody,
  IntegrationSavedResult,
} from '../../dto/integration.dto.js';

@CrudController({
  prefix: 'integration/app',
  label: '企业微信配置',
  entity: IntegrationApp,
  service: IntegrationAppService,
  api: ['page', 'info'],
  pageQuery: {
    keyWords: ['corpId', 'agentId'],
    fieldEq: ['platform', 'enabled', 'mountOrgId'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class IntegrationAppController extends BaseController<IntegrationApp> {
  constructor(
    private readonly apps: IntegrationAppService,
    private readonly syncer: IntegrationSyncService,
  ) {
    super();
  }
  @Post('save')
  @HttpCode(200)
  @Perms('integration:app:update', { risk: 'high' })
  @ApiOperation({
    operationId: 'integrationAppSave',
    summary: '保存企业微信配置，凭据只写入加密存储',
  })
  @ApiBody({ type: IntegrationSaveBody })
  @ApiResult(IntegrationSavedResult)
  save(@Body() body: IntegrationSaveBody) {
    return this.apps.save(body);
  }

  @Post('sync')
  @HttpCode(200)
  @Perms('integration:app:sync', { risk: 'high' })
  @ApiOperation({
    operationId: 'integrationAppSync',
    summary: '同步企业微信可见范围部门和成员',
  })
  @ApiBody({ type: IntegrationIdBody })
  @ApiResult(IntegrationSavedResult)
  async sync(@Body() body: IntegrationIdBody) {
    const app = await this.apps.visible(body.id);
    if (!app) throw crudErrors.notFound();
    return this.syncer.enqueue(app);
  }
}

@Injectable()
export class IntegrationSyncLogService extends BaseService<IntegrationSyncLog> {}

@CrudController({
  prefix: 'integration/sync-log',
  label: '企业微信同步记录',
  entity: IntegrationSyncLog,
  service: IntegrationSyncLogService,
  api: ['page', 'info'],
  pageQuery: {
    keyWords: ['detail'],
    fieldEq: ['appId', 'status'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class IntegrationSyncLogController extends BaseController<IntegrationSyncLog> {}
