import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { BaseService } from '../../../core/crud/base.service.js';
import type { CrudAction } from '../../../core/crud/crud.types.js';
import { McpOperation } from '../entity/mcp.entity.js';
import { effectiveOperationStatus } from './mcp-operation-status.js';

/** 只读确认列表；确认和执行继续经过 McpService 的实时授权检查。 */
@Injectable()
export class McpOperationListService extends BaseService<McpOperation> {
  protected override select(manager: EntityManager, action: CrudAction) {
    return super
      .select(manager, action)
      .andWhere(
        '(e.ownerId=:operationViewer OR e.approverId=:operationViewer)',
        { operationViewer: this.crud.context.current().userId },
      );
  }

  protected override toRow(row: McpOperation) {
    const visible = super.toRow(row);
    // 仅替换已可见的原值，不能覆盖基类对状态字段的脱敏结果。
    if (visible.status === row.status)
      visible.status = effectiveOperationStatus(row);
    return visible;
  }
}
