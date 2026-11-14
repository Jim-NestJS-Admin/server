import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { IdempotencyLedger } from '../../../core/security/idempotency.ledger.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../core/exceptions/error-code.js';
import { FormSubmissionService } from '../../form/service/form-submission.service.js';
import { SystemDirectory } from '../../system/service/system-directory.service.js';
import { WorkflowDefinitionService } from './workflow-definition.service.js';
import {
  WorkflowInstanceService,
  WorkflowTaskService,
} from './workflow-runtime-views.service.js';
import {
  WorkflowInstance,
  WorkflowTask,
  WorkflowRecord,
  WorkflowOutbox,
} from '../entity/workflow-runtime.entity.js';
import type {
  StartWorkflowBody,
  ApproveWorkflowBody,
} from '../dto/workflow-runtime.dto.js';
import {
  advanceWorkflow,
  runtimeNodes,
  type WorkflowAdvance,
} from './workflow-engine.js';

@Injectable()
export class WorkflowRuntimeService {
  constructor(
    private readonly context: RequestContext,
    private readonly ledger: IdempotencyLedger,
    private readonly repos: TenantRepositoryFactory,
    private readonly definitions: WorkflowDefinitionService,
    private readonly submissions: FormSubmissionService,
    private readonly directory: SystemDirectory,
    private readonly instances: WorkflowInstanceService,
    private readonly tasks: WorkflowTaskService,
  ) {}

  start(body: StartWorkflowBody) {
    return this.ledger.transaction(async (manager) => {
      const userId = this.currentUser();
      const definition = await this.definitions.publishedVersion(
        body.definitionId,
        manager,
      );
      const submission = await this.submissions.forWorkflow(
        body.submissionId,
        userId,
        manager,
      );
      if (submission.definitionId !== definition.formDefinitionId)
        throw crudErrors.badRequest(
          '提交记录与流程绑定的表单版本不一致，请选择匹配的流程版本',
        );
      const instanceRepo = this.repos.for(WorkflowInstance);
      const existing = await instanceRepo
        .query('i', manager)
        .andWhere('i.submissionId = :submissionId', {
          submissionId: submission.id,
        })
        .setLock('pessimistic_read')
        .getOne();
      if (existing) throw this.conflict('该提交已经发起审批，请查看原申请');
      const actors: Record<string, string[]> = {};
      for (const node of runtimeNodes(definition.designer)) {
        actors[node.id] = await this.directory.workflowEnabledUsers(
          node.actor!.type === 'applicant' ? [userId] : node.actor!.ids!,
          manager,
        );
        if (!actors[node.id]!.length && node.empty === 'stop')
          throw crudErrors.badRequest(
            `“${node.name}”没有可用的办理人，请联系管理员调整流程`,
          );
      }
      if (
        Object.values(actors).reduce((count, ids) => count + ids.length, 0) >
        2000
      )
        throw crudErrors.badRequest('单个流程的办理人总数最多2000人次');
      const advanced = await advanceWorkflow({
        code: definition.code,
        revision: definition.revision,
        designer: definition.designer,
        bpmn: definition.bpmn,
        digest: definition.digest,
        compilerVersion: definition.compilerVersion,
        actors,
      });
      const id = await instanceRepo.insert(
        {
          definitionId: definition.id,
          submissionId: submission.id,
          formDefinitionId: definition.formDefinitionId,
          code: definition.code,
          name: definition.name,
          revision: definition.revision,
          applicantId: userId,
          designer: definition.designer,
          bpmn: definition.bpmn,
          digest: definition.digest,
          compilerVersion: definition.compilerVersion,
          actors,
          engineState: advanced.state,
          status: advanced.ended ? 'approved' : 'running',
          endedAt: advanced.ended ? new Date() : null,
        },
        manager,
      );
      await this.repos.for(WorkflowRecord).insert(
        {
          instanceId: id,
          taskId: null,
          nodeId: null,
          action: 'start',
          actorId: userId,
          comment: '',
        },
        manager,
      );
      await this.sync(id, actors, definition.designer.nodes, advanced, manager);
      return this.instances.result(id, manager);
    });
  }

  approve(body: ApproveWorkflowBody) {
    return this.ledger.transaction(async (manager) => {
      const userId = this.currentUser();
      // 全部办理动作遵守task → instance锁序，不能先锁实例再查办理人。
      const task = await this.tasks.locked(body.id, manager);
      if (task.assigneeId !== userId) throw crudErrors.notFound();
      if (task.status !== 'pending' || task.version !== body.version)
        throw this.conflict('待办已处理或已变化，请刷新列表');
      const instance = await this.instances.locked(task.instanceId, manager);
      if (instance.status !== 'running')
        throw this.conflict('流程已结束，不能继续办理');
      if (
        !(await this.directory.workflowEnabledUsers([userId], manager)).length
      )
        throw crudErrors.notFound();
      if (instance.actors[task.nodeId]?.[task.actorIndex] !== userId)
        throw this.conflict('待办与固定办理人快照不一致，请联系管理员');
      const advanced = await advanceWorkflow({
        code: instance.code,
        revision: instance.revision,
        designer: instance.designer,
        bpmn: instance.bpmn,
        digest: instance.digest,
        compilerVersion: instance.compilerVersion,
        actors: instance.actors,
        state: instance.engineState,
        signal: {
          nodeId: task.nodeId,
          executionId: task.executionId,
          index: task.actorIndex,
        },
      });
      await this.repos.for(WorkflowTask).update(
        [task.id],
        {
          status: 'approved',
          completedAt: new Date(),
        },
        manager,
      );
      await this.repos.for(WorkflowRecord).insert(
        {
          instanceId: instance.id,
          taskId: task.id,
          nodeId: task.nodeId,
          action: 'approve',
          actorId: userId,
          comment: body.comment ?? '',
        },
        manager,
      );
      // 实例排他锁已持有；版本仍复核，防止后续新增写入口忘记锁定造成覆盖。
      const current = await this.repos
        .for(WorkflowInstance)
        .query('i', manager)
        .andWhere('i.id = :id AND i.version = :version', {
          id: instance.id,
          version: instance.version,
        })
        .setLock('pessimistic_write')
        .getOne();
      if (!current) throw crudErrors.versionConflict();
      await this.repos.for(WorkflowInstance).update(
        [instance.id],
        {
          engineState: advanced.state,
          status: advanced.ended ? 'approved' : 'running',
          endedAt: advanced.ended ? new Date() : null,
        },
        manager,
      );
      await this.sync(
        instance.id,
        instance.actors,
        instance.designer.nodes,
        advanced,
        manager,
      );
      return this.instances.result(instance.id, manager);
    });
  }

  private async sync(
    instanceId: string,
    actors: Record<string, string[]>,
    nodes: WorkflowInstance['designer']['nodes'],
    advanced: WorkflowAdvance,
    manager: EntityManager,
  ) {
    const repo = this.repos.for(WorkflowTask);
    const tasks = await repo
      .query('t', manager)
      .andWhere('t.instanceId = :instanceId', { instanceId })
      .orderBy('t.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    const waits = new Set(advanced.waits.map((w) => w.executionId));
    const existing = new Map(tasks.map((task) => [task.executionId, task]));
    for (const task of tasks) {
      if (task.status !== 'pending' || waits.has(task.executionId)) continue;
      await repo.update(
        [task.id],
        { status: 'cancelled', completedAt: new Date() },
        manager,
      );
      await this.event(
        'task.cancelled',
        instanceId,
        task.id,
        task.assigneeId,
        manager,
      );
    }
    for (const wait of advanced.waits) {
      const previous = existing.get(wait.executionId);
      if (previous) {
        if (previous.status !== 'pending')
          throw this.conflict('引擎出现已处理待办，不能重复创建');
        continue;
      }
      const assigneeId = actors[wait.nodeId]?.[wait.index];
      const node = nodes.find((node) => node.id === wait.nodeId);
      if (!assigneeId || !node) throw this.conflict('待办快照不完整');
      if (
        !(await this.directory.workflowEnabledUsers([assigneeId], manager))
          .length
      )
        throw crudErrors.badRequest(
          `“${node.name}”的办理人已停用或删除，请联系管理员处理`,
        );
      const id = await repo.insert(
        {
          instanceId,
          nodeId: wait.nodeId,
          name: node.name,
          assigneeId,
          executionId: wait.executionId,
          actorIndex: wait.index,
          status: 'pending',
          completedAt: null,
        },
        manager,
      );
      await this.event('task.created', instanceId, id, assigneeId, manager);
    }
    for (const nodeId of advanced.emptyPassed)
      await this.repos.for(WorkflowRecord).insert(
        {
          instanceId,
          taskId: null,
          nodeId,
          action: 'empty_pass',
          actorId: null,
          comment: '',
        },
        manager,
      );
    if (advanced.ended)
      await this.event('instance.approved', instanceId, null, null, manager);
  }

  private event(
    event: WorkflowOutbox['event'],
    instanceId: string,
    taskId: string | null,
    recipientId: string | null,
    manager: EntityManager,
  ) {
    return this.repos.for(WorkflowOutbox).insert(
      {
        eventKey: `${event}:${taskId ?? instanceId}`,
        event,
        instanceId,
        taskId,
        recipientId,
        status: 'pending',
      },
      manager,
    );
  }
  private currentUser() {
    const ctx = this.context.current();
    if (!ctx.userId || ctx.ignoreTenant) throw crudErrors.notFound();
    return ctx.userId;
  }
  private conflict(message: string) {
    return new BusinessException(ErrorCode.Conflict, message, 409);
  }
}
