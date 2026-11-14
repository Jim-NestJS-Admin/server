import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityManager } from 'typeorm';
import { BaseService } from '../../../core/crud/base.service.js';
import type { CrudTx } from '../../../core/crud/crud.types.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { FormDefinitionService } from '../../form/service/form-definition.service.js';
import { SystemDirectory } from '../../system/service/system-directory.service.js';
import { SystemFieldCatalog } from '../../system/service/system-field.catalog.js';
import { CodeRuleService } from '../../code-rule/service/code-rule.service.js';
import { WorkflowDefinition } from '../entity/workflow-definition.entity.js';
import type { WorkflowDefinitionInput } from '../dto/workflow.dto.js';
import {
  compileWorkflow,
  parseWorkflow,
  workflowInvalid,
} from './workflow-rules.js';

@Injectable()
export class WorkflowDefinitionService extends BaseService<WorkflowDefinition> {
  private readonly saving = new AsyncLocalStorage<{
    expected: number;
    code?: string;
  }>();
  constructor(
    private readonly forms: FormDefinitionService,
    private readonly directory: SystemDirectory,
    private readonly fields: SystemFieldCatalog,
    private readonly codes: CodeRuleService,
    private readonly repos: TenantRepositoryFactory,
  ) {
    super();
  }

  createDefinition(data: WorkflowDefinitionInput) {
    return this.saving.run({ expected: 0 }, () => super.add(data));
  }
  async reviseDefinition(
    id: string,
    expected: number,
    data: WorkflowDefinitionInput,
  ) {
    const original = await this.select(this.crud.dataSource.manager, 'info')
      .andWhere('e.id = :id', { id })
      .getOne();
    if (!original) throw crudErrors.notFound();
    return this.saving.run({ expected, code: original.code }, () =>
      super.add(data),
    );
  }
  private async prepare(
    formDefinitionId: string,
    designer: unknown,
    manager: EntityManager,
  ) {
    const form = await this.forms.forWorkflow(formDefinitionId, manager);
    const cap = await this.fields.delegationLimit(
      'form:submission',
      'values',
      manager,
    );
    const limits = await this.fields.delegationMatrix(
      form.fieldResource,
      manager,
    );
    const parsed = parseWorkflow(
      designer,
      form.fields,
      cap,
      Object.fromEntries(
        Object.entries(limits).map(([field, policy]) => [field, policy.cap]),
      ),
    );
    if (!(await this.directory.workflowReferences(parsed.references, manager)))
      workflowInvalid(
        'data.designer',
        '审批/抄送成员、角色或条件组织不存在、已删除或已停用',
      );
    return parsed;
  }
  protected override async beforeAdd(
    data: Partial<WorkflowDefinition>,
    tx: CrudTx,
  ) {
    const saving = this.saving.getStore();
    if (!saving) throw crudErrors.badRequest('请使用流程创建或修订接口');
    if (!data.name || !data.formDefinitionId || !data.designer)
      throw crudErrors.badRequest('缺少可写的流程名称、表单版本或流程设计');
    const parsed = await this.prepare(
      data.formDefinitionId,
      data.designer,
      tx.manager,
    );
    data.code =
      saving.expected === 0
        ? (await this.codes.nextInTx(tx.manager, 'workflow_definition_code'))
            .codes[0]!
        : saving.code!;
    const first = await this.select(tx.manager, 'add')
      .andWhere('e.code = :code AND e.revision = 1', { code: data.code })
      .setLock('pessimistic_write')
      .getOne();
    if (!first && saving.expected > 0) throw crudErrors.notFound();
    if (first && saving.expected === 0)
      workflowInvalid('data.code', '流程编码已存在，请创建新版本');
    const latest = first
      ? await this.select(tx.manager, 'add')
          .andWhere('e.code = :code', { code: data.code })
          .orderBy('e.revision', 'DESC')
          .setLock('pessimistic_write')
          .getOne()
      : null;
    if ((latest?.revision ?? 0) !== saving.expected)
      throw crudErrors.versionConflict();
    data.revision = saving.expected + 1;
    data.designer = parsed.designer;
    data.status = 'draft';
    Object.assign(
      data,
      compileWorkflow(data.designer, `wf_${data.code}_v${data.revision}`),
      { compilerVersion: 1, publishedAt: null, publishedBy: null },
    );
  }
  async inspect(formDefinitionId: string, designer: unknown) {
    // 只读校验使用普通事务承载跨模块锁定读，不建定义/幂等记录或分配编码。
    return this.crud.dataSource.transaction(async (manager) => {
      const parsed = await this.prepare(formDefinitionId, designer, manager);
      return {
        designer: parsed.designer,
        nodeCount: parsed.nodeCount,
        ...compileWorkflow(parsed.designer, 'wf_preview'),
      };
    });
  }
  async publish(id: string, version: number) {
    return this.transaction(async (tx) => {
      const candidate = await this.select(tx.manager, 'info')
        .andWhere('e.id = :id', { id })
        .getOne();
      if (!candidate) throw crudErrors.notFound();
      // 所有发布/修订先锁第一版，再锁目标；与修订遵守同一顺序。
      await this.select(tx.manager, 'info')
        .andWhere('e.code = :code AND e.revision = 1', { code: candidate.code })
        .setLock('pessimistic_write')
        .getOne();
      const row = await this.select(tx.manager, 'info')
        .andWhere('e.id = :id', { id })
        .setLock('pessimistic_write')
        .getOne();
      if (!row) throw crudErrors.notFound();
      if (row.version !== version || row.status !== 'draft')
        throw crudErrors.versionConflict();
      const newer = await this.select(tx.manager, 'info')
        .andWhere(
          'e.code = :code AND e.status = :status AND e.revision > :revision',
          { code: row.code, status: 'published', revision: row.revision },
        )
        .setLock('pessimistic_read')
        .getOne();
      if (newer)
        throw crudErrors.badRequest('已有更新的发布版本，不能发布旧草稿');
      const parsed = await this.prepare(
        row.formDefinitionId,
        row.designer,
        tx.manager,
      );
      const compiled = compileWorkflow(
        parsed.designer,
        `wf_${row.code}_v${row.revision}`,
      );
      if (
        row.compilerVersion !== 1 ||
        compiled.digest !== row.digest ||
        compiled.bpmn !== row.bpmn
      )
        throw crudErrors.badRequest('流程编译结果不一致，请创建新版本');
      const repo = this.repos.for(WorkflowDefinition);
      const changed = await repo.update(
        [row.id],
        {
          status: 'published',
          publishedAt: new Date(),
          publishedBy: tx.ctx.userId,
        },
        tx.manager,
      );
      if (changed !== 1) throw crudErrors.versionConflict();
      const updated = await this.select(tx.manager, 'info')
        .andWhere('e.id = :id', { id })
        .getOne();
      if (!updated) throw crudErrors.notFound();
      return this.toRow(updated);
    });
  }
  /** T38只可固定引用已发布快照，不能每次按编码重新读取最新版替换实例定义。 */
  async publishedVersion(id: string, manager: EntityManager) {
    const row = await this.select(manager, 'info')
      .andWhere('e.id = :id AND e.status = :status', {
        id,
        status: 'published',
      })
      .getOne();
    if (!row) throw crudErrors.notFound();
    return structuredClone(row);
  }
  protected override async beforeUpdate(): Promise<void> {
    throw crudErrors.badRequest('流程快照不可修改，请创建新版本');
  }
  protected override async beforeDelete(): Promise<void> {
    throw crudErrors.badRequest('流程历史版本不可删除');
  }
}
