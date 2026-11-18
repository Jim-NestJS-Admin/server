import { Body, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBody, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { AdminController } from '../../../../core/endpoint/endpoint.decorators.js';
import {
  Perms,
  LoginOnly,
} from '../../../../core/permission/perms.decorator.js';
import { ApiResult } from '../../../../core/swagger/api-result.js';
import { UserRateLimit } from '../../../../core/security/user-rate-limit.js';
import {
  OAuthClient,
  OAuthGrant,
  OAuthEvent,
} from '../../entity/oauth.entity.js';
import { OAuthClientService } from '../../service/oauth-client.service.js';
import { OAuthGrantService } from '../../service/oauth-grant.service.js';
import { OAuthRuntimeService } from '../../service/oauth-runtime.service.js';
import { OAuthScopesService } from '../../service/oauth-scopes.service.js';
import { SystemOAuthService } from '../../../system/service/system-oauth.service.js';
import {
  OAuthClientSaveBody,
  OAuthSavedResult,
  OAuthIdBody,
  OAuthInteractionQuery,
  OAuthInteractionResult,
  OAuthConsentBody,
  OAuthConsentResult,
  OAuthScopesResult,
  OAuthServiceAccountBody,
  OAuthMyGrantsResult,
  OAuthStatusResult,
  OAuthIntegrationSaveBody,
  OAuthIntegrationResult,
} from '../../dto/oauth.dto.js';
import { AppConfigService } from '../../../../core/config/app-config.service.js';
@CrudController({
  prefix: 'oauth/client',
  label: 'OAuth应用',
  entity: OAuthClient,
  service: OAuthClientService,
  api: ['page', 'info', 'delete'],
  pageQuery: {
    keyWords: ['name', 'clientId'],
    fieldEq: ['clientId', 'enabled', 'authMethod', 'serviceOrgId'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class OAuthClientController extends BaseController<OAuthClient> {
  constructor(
    private readonly clients: OAuthClientService,
    private readonly scopes: OAuthScopesService,
    private readonly config: AppConfigService,
  ) {
    super();
  }
  @Get('integration')
  @Perms('oauth:client:info')
  @ApiOperation({
    operationId: 'oauthIntegrationInfo',
    summary: '系统对接应用及所选业务角色，不返回密钥',
  })
  @ApiQuery({ name: 'id', type: String })
  @ApiResult(OAuthIntegrationResult)
  integration(@Query() query: OAuthIdBody) {
    return this.clients.integrationInfo(query.id);
  }
  @Post('integration-save')
  @HttpCode(200)
  @Perms('oauth:client:update', { risk: 'high' })
  @ApiOperation({
    operationId: 'oauthIntegrationSave',
    summary: '创建或修改系统接入凭据，自动绑定服务身份和组织角色',
  })
  @ApiBody({ type: OAuthIntegrationSaveBody })
  @ApiResult(OAuthSavedResult)
  integrationSave(@Body() body: OAuthIntegrationSaveBody) {
    return this.clients.saveIntegration(body);
  }
  @Post('save')
  @HttpCode(200)
  @Perms('oauth:client:update', { risk: 'high' })
  @ApiOperation({
    operationId: 'oauthClientSave',
    summary: '登记或更新应用与允许scope（密钥仅哈希）',
  })
  @ApiBody({ type: OAuthClientSaveBody })
  @ApiResult(OAuthSavedResult)
  save(@Body() body: OAuthClientSaveBody) {
    return this.clients.saveClient(body);
  }
  @Get('scopes')
  @Perms('oauth:client:page')
  @ApiOperation({
    operationId: 'oauthScopes',
    summary: '后端定义的scope与权限码映射',
  })
  @ApiResult(OAuthScopesResult)
  available() {
    return this.scopes.list();
  }
  @Get('status')
  @Perms('oauth:client:page')
  @ApiOperation({
    operationId: 'oauthStatus',
    summary: '部署启用状态，不返回密钥',
  })
  @ApiResult(OAuthStatusResult)
  status() {
    const c = this.config.oauth;
    return {
      enabled: c.enabled,
      issuer: c.issuer,
      dcrEnabled: c.dcr,
      cimdEnabled: c.cimd,
    };
  }
}
@CrudController({
  prefix: 'oauth/grant',
  label: '我的授权',
  entity: OAuthGrant,
  service: OAuthGrantService,
  api: ['page', 'info'],
  pageQuery: {
    keyWords: ['clientId', 'grantId', 'audience'],
    fieldEq: ['clientId', 'active', 'audience'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class OAuthGrantController extends BaseController<OAuthGrant> {
  constructor(private readonly grants: OAuthGrantService) {
    super();
  }
  @Post('revoke')
  @HttpCode(200)
  @Perms('oauth:grant:revoke', { risk: 'high' })
  @ApiOperation({
    operationId: 'oauthGrantRevoke',
    summary: '撤销本人授权及令牌族',
  })
  @ApiBody({ type: OAuthIdBody })
  @ApiResult(OAuthSavedResult)
  revoke(@Body() body: OAuthIdBody) {
    return this.grants.revoke(body.id);
  }
  @Get('mine')
  @LoginOnly()
  @ApiOperation({
    operationId: 'oauthMyGrants',
    summary: '本人最近200项授权，无额外管理权限',
  })
  @ApiResult(OAuthMyGrantsResult)
  mine() {
    return this.grants.mine();
  }
  @Post('revoke-mine')
  @HttpCode(200)
  @LoginOnly()
  @ApiOperation({
    operationId: 'oauthMyGrantRevoke',
    summary: '本人撤销授权，无额外管理权限',
  })
  @ApiBody({ type: OAuthIdBody })
  @ApiResult(OAuthSavedResult)
  revokeMine(@Body() body: OAuthIdBody) {
    return this.grants.revoke(body.id);
  }
}
@AdminController('oauth/interaction')
export class OAuthInteractionController {
  constructor(private readonly oauth: OAuthRuntimeService) {}
  @Get()
  @LoginOnly()
  @ApiOperation({
    operationId: 'oauthInteractionDetails',
    summary: '读取绑定浏览器的授权申请及当前可授予scope',
  })
  @ApiQuery({ name: 'uid', type: String, required: true })
  @ApiResult(OAuthInteractionResult)
  details(
    @Query() query: OAuthInteractionQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.oauth.details(query.uid, req, res);
  }
  @Post('complete')
  @HttpCode(200)
  @LoginOnly()
  @UserRateLimit('oauth-consent', 20, 60)
  @ApiOperation({
    operationId: 'oauthInteractionComplete',
    summary: '本人确认或拒绝固定组织授权',
  })
  @ApiBody({ type: OAuthConsentBody })
  @ApiResult(OAuthConsentResult)
  complete(
    @Body() body: OAuthConsentBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.oauth.consent(body, req, res);
  }
}
@AdminController('oauth/service-account')
export class OAuthServiceAccountController {
  constructor(private readonly system: SystemOAuthService) {}
  @Post('create')
  @HttpCode(200)
  @Perms('oauth:service-account:add', { risk: 'high' })
  @ApiOperation({
    operationId: 'oauthServiceAccountCreate',
    summary: '创建无密码、禁止交互登录的服务账号；角色另行分配',
  })
  @ApiBody({ type: OAuthServiceAccountBody })
  @ApiResult(OAuthSavedResult)
  create(@Body() body: OAuthServiceAccountBody) {
    return this.system.create(body.name, body.orgId);
  }
}
@CrudController({
  prefix: 'oauth/event',
  label: 'OAuth授权审计',
  entity: OAuthEvent,
  api: ['page', 'info'],
  pageQuery: {
    keyWords: ['action', 'clientId', 'grantId'],
    fieldEq: ['action', 'clientId', 'grantId'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class OAuthEventController extends BaseController<OAuthEvent> {}
