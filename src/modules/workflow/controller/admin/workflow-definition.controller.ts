import { Body, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOperation } from '@nestjs/swagger';
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { Perms } from '../../../../core/permission/perms.decorator.js';
import { ApiErrors, ApiResult } from '../../../../core/swagger/api-result.js';
import {
  CreateWorkflowBody,
  ReviseWorkflowBody,
  InspectWorkflowBody,
  PublishWorkflowBody,
  WorkflowInspection,
} from '../../dto/workflow.dto.js';
import { WorkflowDefinition } from '../../entity/workflow-definition.entity.js';
import { WorkflowDefinitionService } from '../../service/workflow-definition.service.js';
import {
  WorkflowAvailableBody,
  WorkflowAvailableResult,
} from '../../dto/workflow-available.dto.js';

@CrudController({
  prefix: 'workflow/definition',
  label: '流程定义',
  entity: WorkflowDefinition,
  service: WorkflowDefinitionService,
  api: ['page', 'info'],
  pageQuery: {
    keyWords: ['code', 'name'],
    fieldEq: ['code', 'revision', 'status', 'formDefinitionId'],
    defaultSort: [{ field: 'revision', order: 'desc' }],
  },
})
export class WorkflowDefinitionController extends BaseController<WorkflowDefinition> {
  constructor(private readonly definitions: WorkflowDefinitionService) {
    super();
  }
  @Post('available')
  @HttpCode(200)
  @Perms('workflow:instance:add')
  @ApiOperation({
    operationId: 'workflowDefinitionAvailable',
    summary:
      '发起人分页选择已发布流程；指定id时返回固定表单和自选节点，不授予流程管理权限',
  })
  @ApiBody({ type: WorkflowAvailableBody })
  @ApiResult(WorkflowAvailableResult)
  available(@Body() body: WorkflowAvailableBody) {
    return this.definitions.availableForStart(body);
  }
  @Post('add')
  @HttpCode(200)
  @Perms('workflow:definition:add')
  @ApiOperation({
    operationId: 'workflowDefinitionAdd',
    summary: '创建流程第一版不可变草稿',
  })
  @ApiBody({ type: CreateWorkflowBody })
  @ApiResult(WorkflowDefinition)
  @ApiErrors(400, 403, 404, 409)
  create(@Body() body: CreateWorkflowBody) {
    return this.definitions.createDefinition(body.data);
  }

  @Post('revise')
  @HttpCode(200)
  @Perms('workflow:definition:update')
  @ApiOperation({
    operationId: 'workflowDefinitionRevise',
    summary: '追加流程新版本，不修改旧修订或进行中实例',
  })
  @ApiBody({ type: ReviseWorkflowBody })
  @ApiResult(WorkflowDefinition)
  @ApiErrors(400, 403, 404, 409)
  revise(@Body() body: ReviseWorkflowBody) {
    return this.definitions.reviseDefinition(
      body.definitionId,
      body.baseRevision,
      body.data,
    );
  }

  @Post('inspect')
  @HttpCode(200)
  @Perms('workflow:definition:info')
  @ApiOperation({
    operationId: 'workflowDefinitionInspect',
    summary: '校验安全流程树及依赖并编译BPMN，不保存或分配编码',
  })
  @ApiBody({ type: InspectWorkflowBody })
  @ApiResult(WorkflowInspection)
  @ApiErrors(400, 403, 404)
  inspect(@Body() body: InspectWorkflowBody) {
    return this.definitions.inspect(body.formDefinitionId, body.designer);
  }

  @Post('publish')
  @HttpCode(200)
  @Perms('workflow:definition:publish', { risk: 'high' })
  @ApiOperation({
    operationId: 'workflowDefinitionPublish',
    summary: '复核依赖并发布固定流程修订，不发起审批',
  })
  @ApiBody({ type: PublishWorkflowBody })
  @ApiResult(WorkflowDefinition)
  @ApiErrors(400, 403, 404, 409)
  publish(@Body() body: PublishWorkflowBody) {
    return this.definitions.publish(body.id, body.version);
  }
}
