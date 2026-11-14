import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { IdempotencyLedger } from '../../../core/security/idempotency.ledger.js';
import { withDocumentAccess } from '../../../core/permission/document-access.js';
import {
  STATE_RANK,
  type FieldState,
} from '../../../core/field-perm/field-perm.decorator.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../core/exceptions/error-code.js';
import { FormSubmissionService } from '../../form/service/form-submission.service.js';
import { SystemDirectory } from '../../system/service/system-directory.service.js';
import { SystemFieldCatalog } from '../../system/service/system-field.catalog.js';
import { SystemOperationRecorder } from '../../system-log/service/system-audit.service.js';
import { FileUsageService } from '../../file/service/file-usage.service.js';
import { FileService } from '../../file/service/file.service.js';
import { WorkflowDefinitionService } from './workflow-definition.service.js';
import {
  WorkflowInstanceService,
  WorkflowTaskService,
  WorkflowRecordService,
} from './workflow-runtime-views.service.js';
import {
  WorkflowInstance,
  WorkflowTask,
  WorkflowRecord,
  WorkflowOutbox,
} from '../entity/workflow-runtime.entity.js';
import { WorkflowTimer } from '../entity/workflow-timer.entity.js';
import type { WorkflowNode } from '../dto/workflow.dto.js';
import type {
  StartWorkflowBody,
  ApproveWorkflowBody,
  TransferWorkflowBody,
  WorkflowInstanceActionBody,
  ResubmitWorkflowBody,
} from '../dto/workflow-runtime.dto.js';
import {
  advanceWorkflow,
  type WorkflowAdvance,
  type WorkflowWait,
} from './workflow-engine.js';
import { WorkflowPlanner, runtimeNodes } from './workflow-plan.js';
import { workflowFailure } from './workflow-failure.js';

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
    private readonly records: WorkflowRecordService,
    private readonly planner: WorkflowPlanner,
    private readonly fields: SystemFieldCatalog,
    private readonly db: DataSource,
    private readonly attachments: FileUsageService,
    private readonly files: FileService,
    private readonly audit: SystemOperationRecorder,
  ) {}

  /** 业务模块可传入固定业务版本引用；HTTP只接收正式表单提交，不接受客户端自报业务归属。 */
  start(body: StartWorkflowBody, business?: { type: string; id: string }) {
    return this.transaction(async (manager) => {
      const userId = this.currentUser();
      const ctx = this.context.current();
      const identity = await this.directory.workflowIdentity(
        userId,
        ctx.orgId,
        manager,
      );
      if (!identity) throw crudErrors.notFound();
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
        throw crudErrors.badRequest('提交记录与流程绑定的表单版本不一致');
      const businessType = business?.type ?? 'form/submission';
      const businessId = business?.id ?? submission.id;
      if (
        !/^[a-z][a-z0-9/-]{1,63}$/.test(businessType) ||
        !businessId ||
        businessId.length > 64
      )
        throw crudErrors.badRequest('业务版本引用无效');
      const existing = await this.repos
        .for(WorkflowInstance)
        .query('i', manager)
        .andWhere(
          '(i.originSubmissionId = :id OR (i.businessType = :businessType AND i.businessId = :businessId))',
          { id: submission.id, businessType, businessId },
        )
        .setLock('pessimistic_read')
        .getOne();
      if (existing)
        throw this.conflict('该提交或业务版本已经发起审批，请查看原申请');
      const snapshot: Partial<WorkflowInstance> = {
        definitionId: definition.id,
        originSubmissionId: submission.id,
        submissionId: submission.id,
        formDefinitionId: definition.formDefinitionId,
        code: definition.code,
        name: definition.name,
        revision: definition.revision,
        applicantId: userId,
        applicantOrgId: ctx.orgId,
        applicantRoles: identity.roleIds,
        selections: body.selections ?? {},
        actors: {},
        designer: definition.designer,
        bpmn: definition.bpmn,
        digest: definition.digest,
        compilerVersion: definition.compilerVersion,
        round: 1,
        viewerIds: [userId],
        decisions: {},
        formChanges: {},
        businessType,
        businessId,
        status: 'running',
        endedAt: null,
      };
      const instance = Object.assign(new WorkflowInstance(), snapshot);
      const advanced = await this.advance(instance, manager);
      instance.engineState = advanced.state;
      instance.status = advanced.ended ? 'approved' : 'running';
      instance.endedAt = advanced.ended ? new Date() : null;
      const id = await this.repos
        .for(WorkflowInstance)
        .insert(instance, manager);
      instance.id = id;
      await this.record(instance, 'start', userId, null, '', [], manager);
      await this.sync(instance, advanced, manager);
      await this.save(instance, manager);
      return this.instances.result(id, manager);
    });
  }

  approve(body: ApproveWorkflowBody) {
    return this.taskAction('approve', body);
  }
  reject(body: ApproveWorkflowBody) {
    return this.taskAction('reject', body);
  }
  transfer(body: TransferWorkflowBody) {
    return this.taskAction('transfer', body);
  }

  private taskAction(
    action: 'approve' | 'reject' | 'transfer',
    body: ApproveWorkflowBody | TransferWorkflowBody,
  ) {
    return this.transaction(async (manager) => {
      const userId = this.currentUser();
      const task = await this.tasks.locked(body.id, manager);
      if (task.assigneeId !== userId || task.kind !== 'approve')
        throw crudErrors.notFound();
      if (task.status !== 'pending' || task.version !== body.version)
        throw this.conflict('待办已处理或已变化，请刷新列表');
      const instance = await this.instances.locked(task.instanceId, manager);
      if (instance.status !== 'running' || task.round !== instance.round)
        throw this.conflict('流程已结束或已重新提交');
      if (
        !(await this.directory.workflowEnabledUsers([userId], manager)).length
      )
        throw crudErrors.notFound();
      if (instance.actors[task.nodeId]?.[task.actorIndex] !== userId)
        throw this.conflict('待办与办理人快照不一致');
      const ids = body.attachmentIds ?? [];
      if (!(await this.attachments.owned(ids, userId, manager)))
        throw crudErrors.badRequest('附件必须是本人已上传且仍有效的文件');
      if (action !== 'approve' && Object.keys(body.values ?? {}).length)
        throw crudErrors.badRequest('只有同意办理时才能保存节点可编辑字段');
      if (action === 'transfer') {
        await this.reassign(
          instance,
          task,
          (body as TransferWorkflowBody).targetUserId,
          userId,
          body.comment ?? '',
          ids,
          manager,
        );
      } else if (action === 'reject') {
        await this.finishTask(task, 'rejected', manager);
        await this.record(
          instance,
          'reject',
          userId,
          task,
          body.comment ?? '',
          ids,
          manager,
        );
        await this.cancelPending(instance, manager);
        instance.status = 'returned';
        instance.endedAt = null;
        await this.event(
          instance,
          'instance.returned',
          null,
          instance.applicantId,
          manager,
        );
      } else {
        if (Object.keys(body.values ?? {}).length)
          instance.formChanges = await this.document(instance, async () =>
            this.submissions.workflowPatch(
              instance.submissionId,
              body.values!,
              await this.access(instance, task, true, manager),
              manager,
            ),
          );
        const advanced = await this.advance(
          instance,
          manager,
          {
            nodeId: task.nodeId,
            executionId: this.engineId(task.executionId),
            index: task.actorIndex,
          },
          userId,
        );
        await this.finishTask(task, 'approved', manager);
        await this.record(
          instance,
          'approve',
          userId,
          task,
          body.comment ?? '',
          ids,
          manager,
          undefined,
          null,
          body.values ?? {},
        );
        instance.engineState = advanced.state;
        instance.status = advanced.ended ? 'approved' : 'running';
        instance.endedAt = advanced.ended ? new Date() : null;
        await this.sync(instance, advanced, manager);
      }
      await this.save(instance, manager);
      return this.instances.result(instance.id, manager);
    });
  }

  withdraw(body: WorkflowInstanceActionBody) {
    return this.transaction(async (manager) => {
      const instance = await this.lockApplicant(body, manager);
      if (!['running', 'returned'].includes(instance.status))
        throw this.conflict('流程已结束，不能撤回');
      await this.cancelPending(instance, manager);
      instance.status = 'withdrawn';
      instance.endedAt = new Date();
      await this.record(
        instance,
        'withdraw',
        this.currentUser(),
        null,
        body.comment ?? '',
        [],
        manager,
      );
      // 仅入发件箱；已办理人和当前办理人都会收到撤回事件，实际投递由T39负责。
      for (const recipient of instance.viewerIds)
        await this.event(
          instance,
          'instance.withdrawn',
          null,
          recipient,
          manager,
          recipient,
        );
      await this.save(instance, manager);
      return this.instances.result(instance.id, manager);
    });
  }

  resubmit(body: ResubmitWorkflowBody) {
    return this.transaction(async (manager) => {
      const instance = await this.lockApplicant(body, manager);
      if (instance.status !== 'returned')
        throw this.conflict('只有退回申请人的申请可以重新提交');
      if (instance.round >= 1000)
        throw crudErrors.badRequest('申请修改次数已达到上限，请联系管理员');
      const identity = await this.directory.workflowIdentity(
        instance.applicantId,
        instance.applicantOrgId,
        manager,
      );
      if (!identity) throw crudErrors.notFound();
      if (body.values)
        instance.formChanges = await this.document(instance, async () =>
          this.submissions.workflowPatch(
            instance.submissionId,
            body.values!,
            await this.access(instance, null, true, manager),
            manager,
          ),
        );
      instance.round++;
      instance.status = 'running';
      instance.endedAt = null;
      instance.actors = {};
      instance.decisions = {};
      instance.applicantRoles = identity.roleIds;
      instance.selections = body.selections ?? instance.selections;
      const advanced = await this.advance(
        instance,
        manager,
        undefined,
        undefined,
        true,
      );
      instance.engineState = advanced.state;
      instance.status = advanced.ended ? 'approved' : 'running';
      instance.endedAt = advanced.ended ? new Date() : null;
      await this.record(
        instance,
        'resubmit',
        this.currentUser(),
        null,
        body.comment ?? '',
        [],
        manager,
        undefined,
        null,
        body.values ?? {},
      );
      await this.sync(instance, advanced, manager);
      await this.save(instance, manager);
      return this.instances.result(instance.id, manager);
    });
  }

  urge(body: WorkflowInstanceActionBody) {
    return this.transaction(async (manager) => {
      const instance = await this.lockApplicant(body, manager);
      if (instance.status !== 'running')
        throw this.conflict('当前申请没有可催办的待办');
      const pending = await this.pending(instance.id, manager);
      if (!pending.length) throw this.conflict('当前申请没有可催办的待办');
      if (
        pending.some(
          (t) =>
            t.lastUrgedAt && t.lastUrgedAt.getTime() > Date.now() - 3600000,
        )
      )
        throw this.conflict('同一待办每小时只能催办一次，请稍后再试');
      for (const task of pending) {
        await this.repos
          .for(WorkflowTask)
          .update([task.id], { lastUrgedAt: new Date() }, manager);
        await this.event(
          instance,
          'task.reminder',
          task.id,
          task.assigneeId,
          manager,
          `urge:${Date.now()}`,
        );
      }
      await this.record(
        instance,
        'urge',
        this.currentUser(),
        null,
        body.comment ?? '',
        [],
        manager,
      );
      await this.save(instance, manager);
      return this.instances.result(instance.id, manager);
    });
  }

  async documentView(id: string, taskId?: string) {
    return this.reading(async (manager) => {
      await this.instances.available(id, manager);
      const userId = this.currentUser();
      if (
        !(await this.directory.workflowEnabledUsers([userId], manager)).length
      )
        throw crudErrors.notFound();
      const own = await this.repos
        .for(WorkflowTask)
        .query('t', manager)
        .andWhere('t.instanceId = :id AND t.assigneeId = :userId', {
          id,
          userId,
        })
        .orderBy('t.id', 'ASC')
        .setLock('pessimistic_read')
        .getMany();
      const instance = await this.instances.shared(id, manager);
      const eligible = own.filter((t) =>
        ['pending', 'approved', 'rejected', 'transferred', 'copied'].includes(
          t.status,
        ),
      );
      if (userId !== instance.applicantId && !eligible.length)
        throw crudErrors.notFound();
      const selected = taskId
        ? eligible.find((task) => task.id === taskId)
        : undefined;
      if (taskId && !selected) throw crudErrors.notFound();
      const cap = await this.fields.delegationLimit(
        'form:submission',
        'values',
        manager,
      );
      const requested = Object.create(null) as Record<string, FieldState>;
      for (const task of selected ? [selected] : eligible)
        for (const [field, state] of Object.entries(task.fieldPermissions)) {
          const effective =
            state === 'editable' &&
            (!selected ||
              task.status !== 'pending' ||
              task.round !== instance.round ||
              instance.status !== 'running')
              ? 'readonly'
              : state;
          if (
            !requested[field] ||
            STATE_RANK[effective] > STATE_RANK[requested[field]!]
          )
            requested[field] = effective;
        }
      const applicant = userId === instance.applicantId && !selected;
      const form = await this.document(instance, () =>
        this.submissions.workflowView(
          instance.submissionId,
          {
            fields: requested,
            cap,
            applicant,
            changes: instance.formChanges,
            editable: applicant
              ? instance.status === 'returned'
              : Boolean(
                  selected &&
                  selected.status === 'pending' &&
                  selected.round === instance.round &&
                  instance.status === 'running',
                ),
          },
          manager,
        ),
      );
      await this.audit.configuration(
        manager,
        'workflow.document.view',
        'workflow/instance',
        null,
        { instanceId: id, submissionId: instance.submissionId },
      );
      const visible = await this.instances.result(id, manager);
      const allTasks = await this.repos
        .for(WorkflowTask)
        .query('t', manager)
        .andWhere('t.instanceId = :id AND t.round = :round', {
          id,
          round: instance.round,
        })
        .getMany();
      const progress = (nodes: WorkflowNode[]): object[] =>
        nodes.map((node) => {
          const descendants = runtimeNodes({
            schemaVersion: 1,
            nodes: [node],
          }).map((n) => n.id);
          const related = allTasks.filter((t) =>
            descendants.includes(t.nodeId),
          );
          const status = related.some((t) => t.status === 'pending')
            ? 'pending'
            : related.some((t) => t.status === 'rejected')
              ? 'returned'
              : related.some((t) => t.status === 'cancelled')
                ? 'cancelled'
                : node.type === 'condition' &&
                    Object.hasOwn(instance.decisions, node.id)
                  ? 'taken'
                  : node.type === 'copy' &&
                      Object.hasOwn(instance.actors, node.id)
                    ? 'copied'
                    : descendants.some((id) =>
                          Object.hasOwn(instance.actors, id),
                        )
                      ? 'approved'
                      : 'waiting';
          return {
            id: node.id,
            name: node.name,
            type: node.type,
            status,
            chosenBranch: instance.decisions[node.id],
            branches: node.branches?.map((b) => ({
              id: b.id,
              name: b.name,
              nodes: progress(b.nodes),
            })),
          };
        });
      return {
        instance: visible,
        form,
        progress: progress(instance.designer.nodes),
      };
    });
  }

  async attachment(id: string, recordId: string, fileId: string) {
    return this.reading(async (manager) => {
      await this.instances.shared(id, manager);
      await this.records.attachment(recordId, id, fileId, manager);
      const file = await withDocumentAccess(
        this.context.current(),
        'file:asset',
        fileId,
        () => this.files.workflowDownload(fileId),
      );
      await this.audit.configuration(
        manager,
        'workflow.attachment.read',
        'workflow/instance',
        null,
        { instanceId: id, recordId, fileId },
      );
      return file;
    });
  }

  /** 被独立调度器调用，认领后办理仍按task → instance → timer，结果和计时器完成同事务提交。 */
  async timeout(timerId: string, claimToken: string) {
    if (
      this.context.current().endpoint !== 'system' ||
      this.context.current().userId !== null
    )
      throw crudErrors.notFound();
    return this.transaction(async (manager) => {
      const candidate = await this.repos
        .for(WorkflowTimer)
        .query('r', manager)
        .andWhere('r.id = :timerId', { timerId })
        .getOne();
      if (!candidate) return;
      const task = await this.repos
        .for(WorkflowTask)
        .query('t', manager)
        .andWhere('t.id = :id', { id: candidate.taskId })
        .setLock('pessimistic_write')
        .getOne();
      if (!task) {
        await this.cancelOrphanTimer(timerId, claimToken, manager);
        return;
      }
      const instance = await this.instances.lockedIfPresent(
        task.instanceId,
        manager,
      );
      if (!instance) {
        await this.cancelOrphanTimer(timerId, claimToken, manager);
        return;
      }
      const timer = await this.repos
        .for(WorkflowTimer)
        .query('r', manager)
        .andWhere('r.id = :timerId', { timerId })
        .setLock('pessimistic_write')
        .getOne();
      if (
        !timer ||
        timer.status !== 'claimed' ||
        timer.claimToken !== claimToken ||
        !timer.claimedUntil ||
        timer.claimedUntil.getTime() <= Date.now()
      )
        return;
      if (
        task.status === 'pending' &&
        instance.status === 'running' &&
        task.round === instance.round
      ) {
        if (timer.action === 'supervisor') {
          const supervisors = await this.directory.workflowActors(
            'supervisor',
            task.assigneeId,
            instance.applicantOrgId,
            [],
            1,
            manager,
          );
          const target = supervisors.find(
            (id) =>
              id !== task.assigneeId &&
              !instance.actors[task.nodeId]?.includes(id),
          );
          if (target)
            await this.reassign(
              instance,
              task,
              target,
              null,
              '超时自动转交上级',
              [],
              manager,
            );
          else
            await this.event(
              instance,
              'task.reminder',
              task.id,
              task.assigneeId,
              manager,
              `timer:${timer.id}`,
            );
        } else
          await this.event(
            instance,
            'task.reminder',
            task.id,
            task.assigneeId,
            manager,
            `timer:${timer.id}`,
          );
        await this.record(
          instance,
          'timeout',
          null,
          task,
          timer.action === 'supervisor'
            ? '超时转上级；无可用上级时保留原待办并提醒'
            : '超时提醒',
          [],
          manager,
        );
        await this.save(instance, manager);
      }
      await this.repos.for(WorkflowTimer).update(
        [timer.id],
        {
          status: 'done',
          claimToken: null,
          claimedUntil: null,
          lastError: null,
        },
        manager,
      );
    });
  }

  private async advance(
    instance: WorkflowInstance,
    manager: EntityManager,
    signal?: WorkflowWait,
    approver?: string,
    fresh = false,
  ) {
    const actors = await this.planner.plan(instance, manager);
    const data = await this.document(instance, () =>
      this.submissions.workflowSnapshot(instance.submissionId, manager),
    );
    const completed = await this.repos
      .for(WorkflowTask)
      .query('t', manager)
      .andWhere(
        't.instanceId = :id AND t.round = :round AND t.status = :status',
        { id: instance.id ?? '0', round: instance.round, status: 'approved' },
      )
      .setLock('pessimistic_read')
      .getMany();
    const approvedBy = Object.create(null) as Record<string, string[]>;
    for (const task of completed)
      (approvedBy[task.nodeId] ??= []).push(task.assigneeId);
    if (signal && approver) (approvedBy[signal.nodeId] ??= []).push(approver);
    const advanced = await advanceWorkflow({
      code: instance.code,
      revision: instance.revision,
      designer: instance.designer,
      bpmn: instance.bpmn,
      digest: instance.digest,
      compilerVersion: instance.compilerVersion,
      actors,
      values: { ...data.row.values, ...instance.formChanges },
      applicantOrgId: instance.applicantOrgId,
      applicantRoles: instance.applicantRoles,
      approvedBy,
      decisions: structuredClone(instance.decisions),
      state: fresh ? undefined : instance.engineState,
      signal,
    });
    instance.decisions = advanced.decisions;
    for (const nodeId of advanced.entered)
      instance.actors[nodeId] = actors[nodeId]!;
    return advanced;
  }

  private async sync(
    instance: WorkflowInstance,
    advanced: WorkflowAdvance,
    manager: EntityManager,
  ) {
    const tasks = await this.repos
      .for(WorkflowTask)
      .query('t', manager)
      .andWhere('t.instanceId = :id AND t.round = :round', {
        id: instance.id,
        round: instance.round,
      })
      .orderBy('t.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    const waitKeys = new Set(
      advanced.waits.map((w) => this.taskKey(instance, w.executionId)),
    );
    for (const task of tasks)
      if (task.status === 'pending' && !waitKeys.has(task.executionId)) {
        await this.finishTask(task, 'cancelled', manager);
        await this.event(
          instance,
          'task.cancelled',
          task.id,
          task.assigneeId,
          manager,
        );
      }
    for (const wait of advanced.waits) {
      const key = this.taskKey(instance, wait.executionId);
      const previous = tasks.find((t) => t.executionId === key);
      if (previous) {
        if (previous.status !== 'pending')
          throw this.conflict('引擎出现已处理待办');
        continue;
      }
      await this.createTask(
        instance,
        wait.nodeId,
        instance.actors[wait.nodeId]![wait.index]!,
        wait.index,
        key,
        'pending',
        manager,
      );
    }
    for (const automatic of advanced.automatic) {
      let task: WorkflowTask | null = null;
      if (automatic.actorId)
        task = await this.createTask(
          instance,
          automatic.nodeId,
          automatic.actorId,
          automatic.index,
          this.taskKey(instance, automatic.executionId),
          'approved',
          manager,
        );
      await this.record(
        instance,
        automatic.reason,
        automatic.actorId,
        task,
        '',
        [],
        manager,
        automatic.nodeId,
      );
    }
    for (const copy of advanced.copies) {
      const ids = instance.actors[copy.nodeId] ?? [];
      for (const [index, userId] of ids.entries()) {
        const key = this.taskKey(instance, `${copy.executionId}:copy:${index}`);
        if (tasks.some((t) => t.executionId === key)) continue;
        await this.createTask(
          instance,
          copy.nodeId,
          userId,
          index,
          key,
          'copied',
          manager,
        );
      }
    }
    if (advanced.ended) {
      await this.event(instance, 'instance.approved', null, null, manager);
      await this.event(
        instance,
        'instance.approved',
        null,
        instance.applicantId,
        manager,
        'applicant',
      );
    }
  }

  private async createTask(
    instance: WorkflowInstance,
    nodeId: string,
    userId: string,
    actorIndex: number,
    executionId: string,
    status: 'pending' | 'approved' | 'copied',
    manager: EntityManager,
  ) {
    const node = runtimeNodes(instance.designer).find((n) => n.id === nodeId);
    if (
      !node ||
      !userId ||
      !(await this.directory.workflowEnabledUsers([userId], manager)).length
    )
      throw crudErrors.badRequest('办理人已停用或删除，请联系管理员调整流程');
    const values: Partial<WorkflowTask> = {
      instanceId: instance.id,
      round: instance.round,
      nodeId,
      name: node.name,
      assigneeId: userId,
      actorIndex,
      executionId,
      status,
      kind: status === 'copied' ? 'copy' : 'approve',
      fieldPermissions: node.fieldPermissions ?? {},
      viewerIds: [userId],
      completedAt: status === 'pending' ? null : new Date(),
      lastUrgedAt: null,
    };
    const id = await this.repos.for(WorkflowTask).insert(values, manager);
    const task = Object.assign(new WorkflowTask(), values, { id });
    if (!instance.viewerIds.includes(userId)) instance.viewerIds.push(userId);
    if (status === 'pending') {
      await this.event(instance, 'task.created', id, userId, manager);
      if (node.timeout)
        await this.repos.for(WorkflowTimer).insert(
          {
            instanceId: instance.id,
            taskId: id,
            dueAt: new Date(Date.now() + node.timeout.minutes * 60000),
            action: node.timeout.action,
            status: 'pending',
            claimToken: null,
            claimedUntil: null,
            attempts: 0,
            lastError: null,
          },
          manager,
        );
    } else if (status === 'copied')
      await this.event(instance, 'task.copied', id, userId, manager);
    return task;
  }

  private async reassign(
    instance: WorkflowInstance,
    task: WorkflowTask,
    target: string,
    actor: string | null,
    comment: string,
    ids: string[],
    manager: EntityManager,
  ) {
    if (
      target === task.assigneeId ||
      instance.actors[task.nodeId]?.includes(target)
    )
      throw crudErrors.badRequest('不能转交给本人或当前节点已有的办理人');
    if (!(await this.directory.workflowEnabledUsers([target], manager)).length)
      throw crudErrors.badRequest('接收人不存在、已停用或不在当前租户');
    await this.finishTask(task, 'transferred', manager);
    // 旧任务保留历史，释放同一引擎执行编号给新待办；节点参与人顺序只替换这一项。
    await this.repos
      .for(WorkflowTask)
      .update(
        [task.id],
        { executionId: `${task.executionId}:old:${task.id}` },
        manager,
      );
    instance.actors[task.nodeId]![task.actorIndex] = target;
    await this.createTask(
      instance,
      task.nodeId,
      target,
      task.actorIndex,
      task.executionId,
      'pending',
      manager,
    );
    await this.record(
      instance,
      'transfer',
      actor,
      task,
      comment,
      ids,
      manager,
      undefined,
      target,
    );
    await this.event(
      instance,
      'task.cancelled',
      task.id,
      task.assigneeId,
      manager,
    );
  }

  private async access(
    instance: WorkflowInstance,
    task: WorkflowTask | null,
    editable: boolean,
    manager: EntityManager,
  ) {
    return {
      fields: task?.fieldPermissions ?? {},
      cap: await this.fields.delegationLimit(
        'form:submission',
        'values',
        manager,
      ),
      changes: instance.formChanges,
      applicant:
        task === null && this.context.current().userId === instance.applicantId,
      editable,
    };
  }
  private document<T>(instance: WorkflowInstance, fn: () => Promise<T>) {
    return withDocumentAccess(
      this.context.current(),
      'form:submission',
      instance.submissionId,
      fn,
    );
  }
  private async lockApplicant(
    body: WorkflowInstanceActionBody,
    manager: EntityManager,
  ) {
    await this.instances.available(body.id, manager);
    await this.pending(body.id, manager);
    const instance = await this.instances.locked(body.id, manager);
    if (instance.applicantId !== this.currentUser())
      throw crudErrors.notFound();
    if (instance.version !== body.version) throw crudErrors.versionConflict();
    return instance;
  }
  private pending(instanceId: string, manager: EntityManager) {
    return this.repos
      .for(WorkflowTask)
      .query('t', manager)
      .andWhere('t.instanceId = :instanceId AND t.status = :status', {
        instanceId,
        status: 'pending',
      })
      .orderBy('t.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
  }
  private async cancelPending(
    instance: WorkflowInstance,
    manager: EntityManager,
  ) {
    for (const task of await this.pending(instance.id, manager)) {
      await this.finishTask(task, 'cancelled', manager);
      await this.event(
        instance,
        'task.cancelled',
        task.id,
        task.assigneeId,
        manager,
      );
    }
  }
  private async finishTask(
    task: WorkflowTask,
    status: WorkflowTask['status'],
    manager: EntityManager,
  ) {
    await this.repos
      .for(WorkflowTask)
      .update([task.id], { status, completedAt: new Date() }, manager);
    const timers = await this.repos
      .for(WorkflowTimer)
      .query('r', manager)
      .andWhere('r.taskId = :id AND r.status IN (:...states)', {
        id: task.id,
        states: ['pending', 'claimed'],
      })
      .setLock('pessimistic_write')
      .getMany();
    for (const timer of timers)
      await this.repos
        .for(WorkflowTimer)
        .update(
          [timer.id],
          { status: 'cancelled', claimToken: null, claimedUntil: null },
          manager,
        );
  }
  private async record(
    instance: WorkflowInstance,
    action: WorkflowRecord['action'],
    actorId: string | null,
    task: WorkflowTask | null,
    comment: string,
    attachmentIds: string[],
    manager: EntityManager,
    nodeId?: string,
    targetUserId: string | null = null,
    formPatch: Record<string, unknown> = {},
  ) {
    return this.repos.for(WorkflowRecord).insert(
      {
        instanceId: instance.id,
        round: instance.round,
        taskId: task?.id ?? null,
        nodeId: nodeId ?? task?.nodeId ?? null,
        action,
        targetUserId,
        formPatch,
        actorId,
        comment,
        attachmentIds,
        submissionId: instance.submissionId,
        viewerIds: [...instance.viewerIds],
      },
      manager,
    );
  }
  private event(
    instance: WorkflowInstance,
    event: WorkflowOutbox['event'],
    taskId: string | null,
    recipientId: string | null,
    manager: EntityManager,
    suffix = '',
  ) {
    return this.repos.for(WorkflowOutbox).insert(
      {
        eventKey: `${event}:${taskId ?? instance.id}:r${instance.round}:${suffix}`,
        event,
        instanceId: instance.id,
        taskId,
        recipientId,
        status: 'pending',
      },
      manager,
    );
  }
  private async updateViewers(
    instance: WorkflowInstance,
    manager: EntityManager,
  ) {
    const tasks = await this.repos
      .for(WorkflowTask)
      .query('t', manager)
      .andWhere('t.instanceId = :id AND t.status IN (:...states)', {
        id: instance.id,
        states: ['pending', 'approved', 'rejected', 'transferred', 'copied'],
      })
      .getMany();
    instance.viewerIds = [
      ...new Set([instance.applicantId, ...tasks.map((t) => t.assigneeId)]),
    ];
    const records = await this.repos
      .for(WorkflowRecord)
      .query('r', manager)
      .andWhere('r.instanceId = :id', { id: instance.id })
      .getMany();
    if (records.length)
      await this.repos.for(WorkflowRecord).update(
        records.map((r) => r.id),
        { viewerIds: [...instance.viewerIds] },
        manager,
      );
  }
  private async save(instance: WorkflowInstance, manager: EntityManager) {
    if (
      instance.version !== undefined &&
      (await this.instances.locked(instance.id, manager)).version !==
        instance.version
    )
      throw crudErrors.versionConflict();
    await this.updateViewers(instance, manager);
    return this.repos.for(WorkflowInstance).update(
      [instance.id],
      {
        status: instance.status,
        endedAt: instance.endedAt,
        engineState: instance.engineState,
        actors: instance.actors,
        decisions: instance.decisions,
        formChanges: instance.formChanges,
        viewerIds: instance.viewerIds,
        submissionId: instance.submissionId,
        round: instance.round,
        applicantRoles: instance.applicantRoles,
        selections: instance.selections,
      },
      manager,
    );
  }
  private taskKey(instance: WorkflowInstance, executionId: string) {
    return `r${instance.round}:${executionId}`;
  }
  private engineId(executionId: string) {
    return executionId.slice(executionId.indexOf(':') + 1);
  }
  private transaction<R>(
    fn: (manager: EntityManager) => Promise<R>,
  ): Promise<R> {
    return this.ledger.transaction(fn).catch(workflowFailure);
  }
  private async cancelOrphanTimer(
    id: string,
    claimToken: string,
    manager: EntityManager,
  ) {
    const row = await this.repos
      .for(WorkflowTimer)
      .query('r', manager)
      .andWhere('r.id = :id', { id })
      .setLock('pessimistic_write')
      .getOne();
    if (row?.status === 'claimed' && row.claimToken === claimToken)
      await this.repos.for(WorkflowTimer).update(
        [id],
        {
          status: 'cancelled',
          claimToken: null,
          claimedUntil: null,
          lastError: '关联实例或待办已不存在，计时器已取消',
        },
        manager,
      );
  }
  private reading<R>(fn: (manager: EntityManager) => Promise<R>): Promise<R> {
    return this.db.transaction('READ COMMITTED', fn).catch(workflowFailure);
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
