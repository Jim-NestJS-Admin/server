import { Body, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { AdminAuth } from '../../../../core/endpoint/endpoint-auth.js';
import { PermissionService } from '../../../../core/permission/permission.service.js';
import { RequestContext } from '../../../../core/tenant/request-context.js';
import { RawResponse } from '../../../../core/decorators/raw-response.decorator.js';
import {
  ApiBody,
  ApiOperation,
  ApiOkResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { AdminController } from '../../../../core/endpoint/endpoint.decorators.js';
import { Perms } from '../../../../core/permission/perms.decorator.js';
import { ApiResult } from '../../../../core/swagger/api-result.js';
import { UserRateLimit } from '../../../../core/security/user-rate-limit.js';
import { AiTask, AiTemplate } from '../../entity/ai.entity.js';
import { AiService } from '../../service/ai.service.js';
import {
  AiSettingsService,
  AiTemplateService,
} from '../../service/ai-settings.service.js';
import {
  AiConfigSaveBody,
  AiConfigResult,
  AiTemplateSaveBody,
  AiSubmitBody,
  AiTaskIdBody,
  AiReceipt,
  AiTaskResult,
  AiUsageResult,
  AiTemplatesResult,
  AiBatchBody,
  AiBatchResult,
} from '../../dto/ai.dto.js';

@CrudController({
  prefix: 'ai/task',
  label: '我的AI任务',
  entity: AiTask,
  service: AiService,
  api: ['page', 'info'],
  pageQuery: {
    keyWords: ['model', 'error'],
    fieldEq: ['feature', 'status', 'model'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class AiTaskController extends BaseController<AiTask> {
  constructor(
    private readonly ai: AiService,
    private readonly auth: AdminAuth,
    private readonly permissions: PermissionService,
    private readonly context: RequestContext,
  ) {
    super();
  }
  @Post('submit')
  @HttpCode(200)
  @Perms('ai:task:add')
  @UserRateLimit('ai-submit', 10, 60)
  @ApiOperation({
    operationId: 'aiTaskSubmit',
    summary: '生成AI草稿任务（只返回编号）',
  })
  @ApiBody({ type: AiSubmitBody })
  @ApiResult(AiReceipt)
  submit(@Body() body: AiSubmitBody) {
    return this.ai.submit(body);
  }
  @Post('batch')
  @HttpCode(200)
  @Perms('ai:task:add')
  @UserRateLimit('ai-batch', 3, 60)
  @ApiOperation({
    operationId: 'aiTaskBatch',
    summary: '批量创建AI草稿任务（最多20项，同事务预占）',
  })
  @ApiBody({ type: AiBatchBody })
  @ApiResult(AiBatchResult)
  batch(@Body() body: AiBatchBody) {
    return this.ai.submitBatch(body.items);
  }
  @Get('events')
  @Perms('ai:task:info')
  @RawResponse()
  @ApiOperation({
    operationId: 'aiTaskEvents',
    summary: '鉴权SSE草稿快照，断开不取消已入队任务',
  })
  @ApiQuery({ name: 'id', type: String, required: true })
  @ApiOkResponse({
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  async events(
    @Query() query: AiTaskIdBody,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    let result = await this.ai.result(query.id);
    const initial = this.context.current();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const deadline = Date.now() + 300000;
    try {
      while (!res.destroyed && !res.writableEnded && Date.now() < deadline) {
        const principal = await this.auth.authenticate(req);
        if (
          principal.tenantId !== initial.tenantId ||
          principal.userId !== initial.userId ||
          principal.orgId !== initial.orgId
        )
          break;
        if (
          !(await this.permissions.permissions()).codes.includes('ai:task:info')
        )
          break;
        result = await this.ai.result(query.id);
        res.write(`data: ${JSON.stringify(result)}\n\n`);
        if (!['queued', 'running'].includes(result.status)) break;
        await delay(600);
      }
    } catch {
      if (!res.destroyed)
        res.write(
          'event: error\ndata: {"message":"会话或权限已变化，请重新打开"}\n\n',
        );
    } finally {
      res.end();
    }
  }
  @Post('result')
  @HttpCode(200)
  @Perms('ai:task:info')
  @ApiOperation({
    operationId: 'aiTaskResult',
    summary: '读取本人当前组织的AI草稿',
  })
  @ApiBody({ type: AiTaskIdBody })
  @ApiResult(AiTaskResult)
  result(@Body() body: AiTaskIdBody) {
    return this.ai.result(body.id);
  }
  @Get('usage')
  @Perms('ai:task:page')
  @ApiOperation({
    operationId: 'aiUsage',
    summary: '租户本月UTC Token用量与预占',
  })
  @ApiResult(AiUsageResult)
  usage() {
    return this.ai.usage();
  }
}

@AdminController('ai/config')
export class AiConfigController {
  constructor(private readonly settings: AiSettingsService) {}
  @Get()
  @Perms('ai:config:info')
  @ApiOperation({
    operationId: 'aiConfigRead',
    summary: '读取AI配置状态（无密钥）',
  })
  @ApiResult(AiConfigResult)
  read() {
    return this.settings.read();
  }
  @Post('save')
  @HttpCode(200)
  @Perms('ai:config:update', { risk: 'high' })
  @ApiOperation({
    operationId: 'aiConfigSave',
    summary: '保存AI配置与加密密钥',
  })
  @ApiBody({ type: AiConfigSaveBody })
  @ApiResult(AiReceipt)
  save(@Body() body: AiConfigSaveBody) {
    return this.settings.save(body);
  }
}

@CrudController({
  prefix: 'ai/template',
  label: 'AI模板历史',
  entity: AiTemplate,
  service: AiTemplateService,
  api: ['page', 'info'],
  pageQuery: {
    keyWords: ['code', 'content'],
    fieldEq: ['code', 'revision'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class AiTemplateController extends BaseController<AiTemplate> {
  constructor(private readonly templates: AiTemplateService) {
    super();
  }
  @Get('available')
  @Perms('ai:template:page')
  @ApiOperation({
    operationId: 'aiTemplatesAvailable',
    summary: '平台默认模板与本租户覆盖',
  })
  @ApiResult(AiTemplatesResult)
  available() {
    return this.templates.available();
  }
  @Post('save')
  @HttpCode(200)
  @Perms('ai:template:add')
  @ApiOperation({
    operationId: 'aiTemplateSave',
    summary: '新增不可变模板修订',
  })
  @ApiBody({ type: AiTemplateSaveBody })
  @ApiResult(AiReceipt)
  save(@Body() body: AiTemplateSaveBody) {
    return this.templates.saveTemplate(body);
  }
}
