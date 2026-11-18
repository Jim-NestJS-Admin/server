import { Body, Get, Post, Query, HttpCode } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AdminController } from '../../../../core/endpoint/endpoint.decorators.js';
import {
  LoginOnly,
  Perms,
} from '../../../../core/permission/perms.decorator.js';
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { ApiResult } from '../../../../core/swagger/api-result.js';
import { UserRateLimit } from '../../../../core/security/user-rate-limit.js';
import { McpService } from '../../service/mcp.service.js';
import { McpEvent } from '../../entity/mcp.entity.js';
import {
  McpConfigBody,
  McpConfigResult,
  McpOperationQuery,
  McpDecisionBody,
  McpReceipt,
  McpOperationResult,
  McpOperationList,
  McpSaved,
  McpDelegationBody,
  McpDelegationResult,
} from '../../dto/mcp.dto.js';
@AdminController('mcp/operation')
export class McpOperationController {
  constructor(private readonly mcp: McpService) {}
  @Get('mine')
  @LoginOnly()
  @ApiOperation({
    operationId: 'mcpOperations',
    summary: '本人发起或待本人确认的操作',
  })
  @ApiResult(McpOperationList)
  mine() {
    return this.mcp.list();
  }
  @Get('details')
  @LoginOnly()
  @ApiOperation({
    operationId: 'mcpOperationDetails',
    summary: '操作参数预览，按原组织及当前字段权限裁剪',
  })
  @ApiQuery({ name: 'id', type: String })
  @ApiResult(McpOperationResult)
  details(@Query() query: McpOperationQuery) {
    return this.mcp.details(query.id);
  }
  @Post('decide')
  @HttpCode(200)
  @LoginOnly()
  @UserRateLimit('mcp-confirm', 20, 60)
  @ApiOperation({
    operationId: 'mcpOperationDecide',
    summary: '本人或指定真人确认/拒绝，服务端直接执行',
  })
  @ApiBody({ type: McpDecisionBody })
  @ApiResult(McpReceipt)
  decide(@Body() body: McpDecisionBody) {
    return this.mcp.decide(body.id, body.approve);
  }
}
@AdminController('mcp/config')
export class McpConfigController {
  constructor(private readonly mcp: McpService) {}
  @Get()
  @Perms('mcp:config:info')
  @ApiOperation({
    operationId: 'mcpConfiguration',
    summary: '租户MCP启停、资源关闭和追加确认策略',
  })
  @ApiResult(McpConfigResult)
  configuration() {
    return this.mcp.configuration();
  }
  @Post('save')
  @HttpCode(200)
  @Perms('mcp:config:update', { risk: 'high' })
  @ApiOperation({
    operationId: 'mcpConfigurationSave',
    summary: '租户管理员保存MCP设置，不能降低内置风险',
  })
  @ApiBody({ type: McpConfigBody })
  @ApiResult(McpSaved)
  save(@Body() body: McpConfigBody) {
    return this.mcp.saveConfiguration(body);
  }
  @Get('delegations')
  @Perms('mcp:delegation:info')
  @ApiOperation({
    operationId: 'mcpDelegations',
    summary: '服务账号指定审批人和精确免确认授权',
  })
  @ApiResult(McpDelegationResult)
  delegations() {
    return this.mcp.delegations();
  }
  @Post('delegation')
  @HttpCode(200)
  @Perms('mcp:delegation:update', { risk: 'high' })
  @ApiOperation({
    operationId: 'mcpDelegationSave',
    summary: '管理员设置审批人或授予/撤销精确免确认',
  })
  @ApiBody({ type: McpDelegationBody })
  @ApiResult(McpSaved)
  delegation(@Body() body: McpDelegationBody) {
    return this.mcp.saveDelegation(body);
  }
  @Get('access')
  @Perms('mcp:use')
  @ApiOperation({ operationId: 'mcpAccess', summary: '角色MCP准入权限登记' })
  @ApiResult(McpSaved)
  access() {
    return { id: 'mcp' };
  }
}
@CrudController({
  prefix: 'mcp/event',
  label: 'MCP调用审计',
  entity: McpEvent,
  api: ['page', 'info'],
  pageQuery: {
    keyWords: ['event', 'clientId', 'resource', 'action'],
    fieldEq: ['event', 'clientId', 'resource', 'action', 'operationId'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class McpEventController extends BaseController<McpEvent> {}
