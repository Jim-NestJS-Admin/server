import { Body, HttpCode, Post, StreamableFile, Header } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiProduces,
} from '@nestjs/swagger';
import { RawResponse } from '../../../../core/decorators/raw-response.decorator.js';
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { Perms } from '../../../../core/permission/perms.decorator.js';
import { ApiErrors, ApiResult } from '../../../../core/swagger/api-result.js';
import {
  WorkflowInstance,
  WorkflowTask,
  WorkflowRecord,
} from '../../entity/workflow-runtime.entity.js';
import {
  StartWorkflowBody,
  ApproveWorkflowBody,
  TransferWorkflowBody,
  WorkflowInstanceActionBody,
  ResubmitWorkflowBody,
  WorkflowDocumentBody,
  WorkflowDocumentResult,
  WorkflowAttachmentBody,
  WorkflowPreviewBody,
} from '../../dto/workflow-runtime.dto.js';
import { WorkflowRuntimeService } from '../../service/workflow-runtime.service.js';
import {
  WorkflowInstanceService,
  WorkflowTaskService,
  WorkflowRecordService,
} from '../../service/workflow-runtime-views.service.js';

@CrudController({
  prefix: 'workflow/instance',
  label: '审批申请',
  entity: WorkflowInstance,
  service: WorkflowInstanceService,
  api: ['page', 'info'],
  dataScope: true,
  pageQuery: {
    keyWords: ['code', 'name', 'businessId'],
    fieldEq: [
      'definitionId',
      'submissionId',
      'applicantId',
      'status',
      'businessType',
      'businessId',
      'round',
    ],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class WorkflowInstanceController extends BaseController<WorkflowInstance> {
  constructor(private readonly runtime: WorkflowRuntimeService) {
    super();
  }
  @Post('start')
  @HttpCode(200)
  @Perms('workflow:instance:add')
  @ApiOperation({
    operationId: 'workflowInstanceStart',
    summary: '由本人正式表单提交发起审批，固定已发布版本',
  })
  @ApiBody({ type: StartWorkflowBody })
  @ApiResult(WorkflowInstance)
  @ApiErrors(400, 403, 404, 409)
  start(@Body() body: StartWorkflowBody) {
    return this.runtime.start(body);
  }
  @Post('document')
  @HttpCode(200)
  @Perms('workflow:instance:info')
  @ApiOperation({
    operationId: 'workflowInstanceDocument',
    summary: '按当前待办或已办只读授权查看单据，记录访问审计',
  })
  @ApiBody({ type: WorkflowDocumentBody })
  @ApiResult(WorkflowDocumentResult)
  @ApiErrors(400, 403, 404)
  document(@Body() body: WorkflowDocumentBody) {
    return this.runtime.documentView(body.id, body.taskId);
  }
  @Post('preview')
  @HttpCode(200)
  @Perms('workflow:instance:info')
  @ApiOperation({
    operationId: 'workflowInstancePreview',
    summary: '预览节点可编辑字段联动，重新裁剪权限，不保存填写内容',
  })
  @ApiBody({ type: WorkflowPreviewBody })
  @ApiResult(WorkflowDocumentResult)
  @ApiErrors(400, 403, 404)
  preview(@Body() body: WorkflowPreviewBody) {
    return this.runtime.documentView(body.id, body.taskId, body.values);
  }

  @Post('withdraw')
  @HttpCode(200)
  @Perms('workflow:instance:withdraw', { risk: 'high' })
  @ApiOperation({
    operationId: 'workflowInstanceWithdraw',
    summary: '申请人撤回未结束的流程并收回待办授权',
  })
  @ApiBody({ type: WorkflowInstanceActionBody })
  @ApiResult(WorkflowInstance)
  @ApiErrors(400, 403, 404, 409)
  withdraw(@Body() body: WorkflowInstanceActionBody) {
    return this.runtime.withdraw(body);
  }

  @Post('resubmit')
  @HttpCode(200)
  @Perms('workflow:instance:resubmit')
  @ApiOperation({
    operationId: 'workflowInstanceResubmit',
    summary: '退回申请人修改后重新提交，保留原记录和固定定义',
  })
  @ApiBody({ type: ResubmitWorkflowBody })
  @ApiResult(WorkflowInstance)
  @ApiErrors(400, 403, 404, 409)
  resubmit(@Body() body: ResubmitWorkflowBody) {
    return this.runtime.resubmit(body);
  }

  @Post('urge')
  @HttpCode(200)
  @Perms('workflow:instance:urge')
  @ApiOperation({
    operationId: 'workflowInstanceUrge',
    summary: '申请人催办，同一待办每小时最多一次',
  })
  @ApiBody({ type: WorkflowInstanceActionBody })
  @ApiResult(WorkflowInstance)
  @ApiErrors(400, 403, 404, 409)
  urge(@Body() body: WorkflowInstanceActionBody) {
    return this.runtime.urge(body);
  }

  @Post('attachment')
  @HttpCode(200)
  @Perms('workflow:instance:info')
  @ApiOperation({
    operationId: 'workflowInstanceAttachment',
    summary: '仅下载本实例可见审批记录内的附件',
  })
  @ApiBody({ type: WorkflowAttachmentBody })
  @ApiProduces('application/octet-stream')
  @ApiResponse({ status: 200, schema: { type: 'string', format: 'binary' } })
  @ApiErrors(400, 403, 404)
  @RawResponse()
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'private, no-store')
  async attachment(@Body() body: WorkflowAttachmentBody) {
    const file = await this.runtime.attachment(
      body.id,
      body.recordId,
      body.fileId,
    );
    return new StreamableFile(file.data, {
      type: 'application/octet-stream',
      disposition: `attachment; filename="${file.name}"`,
      length: file.data.length,
    });
  }
}

@CrudController({
  prefix: 'workflow/task',
  label: '我的审批任务',
  entity: WorkflowTask,
  service: WorkflowTaskService,
  api: ['page', 'info'],
  dataScope: true,
  pageQuery: {
    keyWords: ['name'],
    fieldEq: ['instanceId', 'nodeId', 'status', 'kind', 'round'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class WorkflowTaskController extends BaseController<WorkflowTask> {
  constructor(private readonly runtime: WorkflowRuntimeService) {
    super();
  }
  @Post('approve')
  @HttpCode(200)
  @Perms('workflow:task:approve', { risk: 'high' })
  @ApiOperation({
    operationId: 'workflowTaskApprove',
    summary: '本人待办同意，原子推进流程和记录结果',
  })
  @ApiBody({ type: ApproveWorkflowBody })
  @ApiResult(WorkflowInstance)
  @ApiErrors(400, 403, 404, 409)
  approve(@Body() body: ApproveWorkflowBody) {
    return this.runtime.approve(body);
  }
  @Post('reject')
  @HttpCode(200)
  @Perms('workflow:task:reject', { risk: 'high' })
  @ApiOperation({
    operationId: 'workflowTaskReject',
    summary: '本人待办驳回申请人，取消所有并行待办',
  })
  @ApiBody({ type: ApproveWorkflowBody })
  @ApiResult(WorkflowInstance)
  @ApiErrors(400, 403, 404, 409)
  reject(@Body() body: ApproveWorkflowBody) {
    return this.runtime.reject(body);
  }

  @Post('transfer')
  @HttpCode(200)
  @Perms('workflow:task:transfer', { risk: 'high' })
  @ApiOperation({
    operationId: 'workflowTaskTransfer',
    summary: '本人待办转交同租户有效成员，原授权立即收回',
  })
  @ApiBody({ type: TransferWorkflowBody })
  @ApiResult(WorkflowInstance)
  @ApiErrors(400, 403, 404, 409)
  transfer(@Body() body: TransferWorkflowBody) {
    return this.runtime.transfer(body);
  }
}

@CrudController({
  prefix: 'workflow/record',
  label: '审批记录',
  entity: WorkflowRecord,
  service: WorkflowRecordService,
  api: ['page', 'info'],
  dataScope: true,
  pageQuery: {
    fieldEq: ['instanceId', 'taskId', 'actorId', 'action', 'round'],
    defaultSort: [{ field: 'id', order: 'asc' }],
  },
})
export class WorkflowRecordController extends BaseController<WorkflowRecord> {}
