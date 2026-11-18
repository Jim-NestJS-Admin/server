import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import {
  WorkflowInstance,
  WorkflowOutbox,
  WorkflowTask,
} from '../entity/workflow-runtime.entity.js';

/** 由审批模块持有自己的发件箱；消费者不得直接访问审批表。 */
@Injectable()
export class WorkflowOutboxService {
  constructor(private readonly repos: TenantRepositoryFactory) {}

  async taskReference(id: string) {
    const task = await this.repos
      .for(WorkflowTask)
      .query('t')
      .andWhere('t.id = :id', { id })
      .getOne();
    return task
      ? {
          id: task.id,
          version: task.version,
          assigneeId: task.assigneeId,
          status: task.status,
          instanceId: task.instanceId,
        }
      : null;
  }

  pending(manager: EntityManager) {
    return this.repos
      .for(WorkflowOutbox)
      .query('o', manager)
      .andWhere('o.status = :status', { status: 'pending' })
      .orderBy('o.id', 'ASC')
      .limit(20)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();
  }

  async acknowledge(id: string, manager: EntityManager) {
    await this.repos
      .for(WorkflowOutbox)
      .update([id], { status: 'sent' }, manager);
  }

  async business(id: string, manager: EntityManager) {
    const instance = await this.repos
      .for(WorkflowInstance)
      .query('i', manager)
      .andWhere('i.id = :id', { id })
      .getOne();
    return instance
      ? { type: instance.businessType, id: instance.businessId }
      : null;
  }

  async recipientVisible(
    instanceId: string,
    recipientId: string,
    event: string,
    taskId: string | null,
  ) {
    const instance = await this.repos
      .for(WorkflowInstance)
      .query('i')
      .andWhere('i.id = :id', { id: instanceId })
      .getOne();
    if (!instance) return false;
    const task = taskId
      ? await this.repos
          .for(WorkflowTask)
          .query('t')
          .andWhere(
            't.id = :id AND t.instanceId = :instanceId AND t.assigneeId = :recipientId',
            { id: taskId, instanceId, recipientId },
          )
          .getOne()
      : null;
    if (event === 'task.created' || event === 'task.reminder')
      return (
        task?.status === 'pending' &&
        task.round === instance.round &&
        instance.status === 'running'
      );
    if (event === 'task.copied') return task?.status === 'copied';
    if (instance.applicantId === recipientId) return true;
    return !!(await this.repos
      .for(WorkflowTask)
      .query('t')
      .andWhere(
        't.instanceId = :instanceId AND t.assigneeId = :recipientId AND t.status IN (:...statuses)',
        {
          instanceId,
          recipientId,
          statuses: ['approved', 'rejected', 'transferred', 'copied'],
        },
      )
      .getOne());
  }
}
