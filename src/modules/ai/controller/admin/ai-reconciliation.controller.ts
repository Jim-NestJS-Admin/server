import { Body, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOperation } from '@nestjs/swagger';
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { Perms } from '../../../../core/permission/perms.decorator.js';
import { ApiResult } from '../../../../core/swagger/api-result.js';
import { AiReconciliation } from '../../entity/ai.entity.js';
import { AiReconciliationService } from '../../service/ai-reconciliation.service.js';
import {
  AiReceipt,
  AiReconcileBody,
  AiUncertainResult,
} from '../../dto/ai.dto.js';
@CrudController({
  prefix: 'ai/reconciliation',
  label: 'AI账单核对记录',
  entity: AiReconciliation,
  service: AiReconciliationService,
  api: ['page', 'info'],
  pageQuery: {
    keyWords: ['evidence'],
    fieldEq: ['taskId', 'charged'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class AiReconciliationController extends BaseController<AiReconciliation> {
  constructor(private readonly reconciliation: AiReconciliationService) {
    super();
  }
  @Get('uncertain')
  @Perms('ai:reconciliation:page')
  @ApiOperation({
    operationId: 'aiUncertainTasks',
    summary: '待核对任务（不含正文）',
  })
  @ApiResult(AiUncertainResult)
  uncertain() {
    return this.reconciliation.uncertain();
  }
  @Post('settle')
  @HttpCode(200)
  @Perms('ai:reconciliation:update', { risk: 'high' })
  @ApiOperation({
    operationId: 'aiReconcile',
    summary: '依据提供方账单结算或释放不确定预占',
  })
  @ApiBody({ type: AiReconcileBody })
  @ApiResult(AiReceipt)
  settle(@Body() body: AiReconcileBody) {
    return this.reconciliation.reconcile(body);
  }
}
