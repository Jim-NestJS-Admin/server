import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { BaseService } from '../../../core/crud/base.service.js';
import type { CrudAction } from '../../../core/crud/crud.types.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import {
  WorkflowInstance,
  WorkflowTask,
  WorkflowRecord,
} from '../entity/workflow-runtime.entity.js';

@Injectable()
export class WorkflowInstanceService extends BaseService<WorkflowInstance> {
  async shared(id: string, manager: EntityManager) {
    const row = await this.select(manager, 'info')
      .andWhere('e.id = :id', { id })
      .setLock('pessimistic_read')
      .getOne();
    if (!row) throw crudErrors.notFound();
    return row;
  }
  async available(id: string, manager: EntityManager) {
    const row = await this.select(manager, 'info')
      .andWhere('e.id = :id', { id })
      .getOne();
    if (!row) throw crudErrors.notFound();
    return row;
  }
  async locked(id: string, manager: EntityManager) {
    const row = await this.lockedIfPresent(id, manager);
    if (!row) throw crudErrors.notFound();
    return row;
  }
  async lockedIfPresent(id: string, manager: EntityManager) {
    const row = await this.select(manager, 'info')
      .andWhere('e.id = :id', { id })
      .setLock('pessimistic_write')
      .getOne();
    return row;
  }
  async result(id: string, manager: EntityManager) {
    const row = await this.select(manager, 'info')
      .andWhere('e.id = :id', { id })
      .getOne();
    if (!row) throw crudErrors.notFound();
    const result = this.toRow(row);
    await this.withDisplay([result]);
    return result;
  }
}

@Injectable()
export class WorkflowTaskService extends BaseService<WorkflowTask> {
  /** 待办和已办接口只能看本人任务；额外收窄条件不代替框架数据范围。 */
  protected override select(manager: EntityManager, action: CrudAction) {
    return super
      .select(manager, action)
      .andWhere('e.assigneeId = :__assignee', {
        __assignee: this.crud.context.current().userId,
      });
  }
  async locked(id: string, manager: EntityManager) {
    const row = await this.select(manager, 'info')
      .andWhere('e.id = :id', { id })
      .setLock('pessimistic_write')
      .getOne();
    if (!row) throw crudErrors.notFound();
    return row;
  }
}

@Injectable()
export class WorkflowRecordService extends BaseService<WorkflowRecord> {
  async attachment(
    id: string,
    instanceId: string,
    fileId: string,
    manager: EntityManager,
  ) {
    const row = await this.select(manager, 'info')
      .andWhere('e.id = :id AND e.instanceId = :instanceId', { id, instanceId })
      .getOne();
    const visible = row ? this.toRow(row) : null;
    if (
      !visible ||
      !Array.isArray(visible.attachmentIds) ||
      !visible.attachmentIds.includes(fileId)
    )
      throw crudErrors.notFound();
  }
}
