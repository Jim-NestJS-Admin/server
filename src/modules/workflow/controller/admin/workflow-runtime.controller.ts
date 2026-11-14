import { Body, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOperation } from '@nestjs/swagger';
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
    keyWords: ['code', 'name'],
    fieldEq: ['definitionId', 'submissionId', 'applicantId', 'status'],
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
    summary: '由本人正式表单提交发起审批（第一批直线审批）',
  })
  @ApiBody({ type: StartWorkflowBody })
  @ApiResult(WorkflowInstance)
  @ApiErrors(400, 403, 404, 409)
  start(@Body() body: StartWorkflowBody) {
    return this.runtime.start(body);
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
    fieldEq: ['instanceId', 'nodeId', 'status'],
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
}

@CrudController({
  prefix: 'workflow/record',
  label: '审批记录',
  entity: WorkflowRecord,
  service: WorkflowRecordService,
  api: ['page', 'info'],
  dataScope: true,
  pageQuery: {
    fieldEq: ['instanceId', 'taskId', 'actorId', 'action'],
    defaultSort: [{ field: 'id', order: 'asc' }],
  },
})
export class WorkflowRecordController extends BaseController<WorkflowRecord> {}
