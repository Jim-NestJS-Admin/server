import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { BaseService } from '../../../core/crud/base.service.js';
import type { CrudTx } from '../../../core/crud/crud.types.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { fieldUsageKey } from '../../../core/crud/crud-code.js';
import { FormSubmission } from '../entity/form-submission.entity.js';
import { FormDefinitionService } from './form-definition.service.js';
import { validateFormValues } from './form-rules.js';
import { CodeRuleService } from '../../code-rule/service/code-rule.service.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { documentAccess } from '../../../core/permission/document-access.js';
import { fieldVerdict } from '../../../core/field-perm/field-policy.js';
import {
  STATE_RANK,
  type FieldState,
} from '../../../core/field-perm/field-perm.decorator.js';
import { mask } from '../../../core/field-perm/masks.js';
import { Inject } from '@nestjs/common';
import { SystemFieldCatalog } from '../../system/service/system-field.catalog.js';
import { dynamicFieldResource } from '../../../core/field-perm/dynamic-fields.js';
@Injectable()
export class FormSubmissionService extends BaseService<FormSubmission> {
  async mineForWorkflow(body: {
    definitionId: string;
    page: number;
    size: number;
    keyword: string;
  }) {
    return this.crud.dataSource.transaction(async (manager) => {
      const query = this.select(manager, 'page').andWhere(
        'e.definitionId = :definitionId AND e.createdBy = :owner',
        {
          definitionId: body.definitionId,
          owner: this.request.current().userId,
        },
      );
      if (body.keyword)
        query.andWhere('(e.name LIKE :keyword OR e.code LIKE :keyword)', {
          keyword: `%${body.keyword}%`,
        });
      const [rows, total] = await query
        .orderBy('e.id', 'DESC')
        .skip((body.page - 1) * body.size)
        .take(body.size)
        .getManyAndCount();
      const list = rows.map((row) => this.toRow(row));
      await this.withDisplay(list);
      return { list, total };
    });
  }
  @Inject(SystemFieldCatalog)
  private readonly fieldsCatalog!: SystemFieldCatalog;
  @Inject(RequestContext) private readonly request!: RequestContext;
  constructor(
    private readonly definitions: FormDefinitionService,
    private readonly codesService: CodeRuleService,
  ) {
    super();
  }
  private valueAccess(row: FormSubmission, field: string) {
    const ctx = this.crud.context.current();
    if (ctx.endpoint === 'system')
      return { state: 'editable' as const, mask: null };
    const auth = this.crud.authz.get();
    if (!auth) return { state: 'hidden' as const, mask: null };
    const aggregate = fieldVerdict(
      auth,
      ctx.userId,
      'form:submission',
      FormSubmission,
      'values',
      true,
      row,
    );
    const specific = fieldVerdict(
      auth,
      ctx.userId,
      dynamicFieldResource('form', row.code),
      FormSubmission,
      field,
      true,
      row,
    );
    return STATE_RANK[aggregate.state] < STATE_RANK[specific.state]
      ? aggregate
      : specific;
  }
  protected override toRow(row: FormSubmission) {
    const out = super.toRow(row);
    if (out.values && typeof out.values === 'object')
      out.values = Object.fromEntries(
        Object.entries(out.values).flatMap(([field, value]) => {
          const policy = this.valueAccess(row, field);
          return policy.state === 'hidden'
            ? []
            : [
                [
                  field,
                  policy.state === 'masked'
                    ? mask(value, policy.mask ?? 'all')
                    : value,
                ],
              ];
        }),
      );
    if (out.fieldTitles)
      out.fieldTitles = Object.fromEntries(
        Object.entries(out.fieldTitles).filter(
          ([field]) => this.valueAccess(row, field).state !== 'hidden',
        ),
      );
    if (out.codes)
      out.codes = Object.fromEntries(
        Object.entries(out.codes).flatMap(([field, value]) => {
          const policy = this.valueAccess(row, field);
          return policy.state === 'hidden'
            ? []
            : [
                [
                  field,
                  policy.state === 'masked'
                    ? String(mask(value, policy.mask ?? 'all'))
                    : value,
                ],
              ];
        }),
      );
    return out;
  }
  /** 发起审批仅能引用本人且仍在本次数据范围内的提交，不向workflow复制填写内容。 */
  async forWorkflow(id: string, applicantId: string, manager: EntityManager) {
    const row = await this.select(manager, 'info')
      .andWhere('e.id = :id AND e.createdBy = :applicantId', {
        id,
        applicantId,
      })
      .setLock('pessimistic_write')
      .getOne();
    if (!row || this.toRow(row).definitionId !== row.definitionId)
      throw crudErrors.notFound();
    return { id: row.id, definitionId: row.definitionId };
  }

  /** 仅允许workflow已核实的单据授权；不向普通表单接口扩大可见范围。 */
  async workflowSnapshot(id: string, manager: EntityManager) {
    if (documentAccess(this.request.current(), 'form:submission') !== id)
      throw crudErrors.notFound();
    const row = await this.select(manager, 'info')
      .andWhere('e.id = :id', { id })
      .setLock('pessimistic_read')
      .getOne();
    if (!row) throw crudErrors.notFound();
    const definition = await this.definitions.forSubmission(
      row.definitionId,
      manager,
    );
    return {
      row,
      definition,
      fieldResource: dynamicFieldResource('form', row.code),
    };
  }

  async workflowView(
    id: string,
    access: {
      fields: Record<string, FieldState>;
      cap: FieldState;
      applicant: boolean;
      editable: boolean;
      changes: Record<string, unknown>;
    },
    manager: EntityManager,
  ) {
    const { row, definition, fieldResource } = await this.workflowSnapshot(
      id,
      manager,
    );
    const policies = await this.fieldsCatalog.delegationMatrix(
      fieldResource,
      manager,
    );
    const values: Record<string, unknown> = {};
    const current = { ...row.values, ...access.changes };
    const states: Record<string, FieldState> = {};
    const fields = structuredClone(definition.fields);
    const auth = this.crud.authz.get();
    const aggregate = auth
      ? fieldVerdict(
          auth,
          this.request.current().userId,
          'form:submission',
          FormSubmission,
          'values',
          !access.applicant,
          row,
        ).state
      : 'hidden';
    for (const field of fields) {
      for (const link of definition.designer.linkages ?? [])
        if (link.target === field.field) {
          const matched =
            link.operator === 'in'
              ? (link.value as unknown[]).includes(current[link.source])
              : link.operator === 'eq'
                ? current[link.source] === link.value
                : current[link.source] !== link.value;
          const value = matched ? link.whenTrue : link.whenFalse;
          if (link.action === 'visible' || link.action === 'required')
            field[link.action] = value as boolean;
          else field.options = value as typeof field.options;
        }
      const delegated = Object.hasOwn(access.fields, field.field);
      const own = auth
        ? fieldVerdict(
            auth,
            this.request.current().userId,
            fieldResource,
            FormSubmission,
            field.field,
            !access.applicant,
            row,
          )
        : { state: 'hidden' as const, mask: null };
      const normal =
        STATE_RANK[own.state] < STATE_RANK[aggregate] ? own.state : aggregate;
      const fieldCap = policies[field.field]?.cap ?? 'hidden';
      const cap =
        STATE_RANK[fieldCap] < STATE_RANK[access.cap] ? fieldCap : access.cap;
      let state: FieldState = access.applicant
        ? normal
        : delegated
          ? access.fields[field.field]!
          : normal === 'editable'
            ? 'readonly'
            : normal;
      if (!access.applicant && delegated && STATE_RANK[state] > STATE_RANK[cap])
        state = cap;
      if ((!access.editable || field.generated) && state === 'editable')
        state = 'readonly';
      if (!field.visible) state = 'hidden';
      states[field.field] = state;
      if (state !== 'hidden' && Object.hasOwn(current, field.field))
        values[field.field] =
          state === 'masked'
            ? mask(
                current[field.field],
                policies[field.field]?.mask ?? own.mask ?? 'all',
              )
            : current[field.field];
    }
    return {
      id: row.id,
      definitionId: row.definitionId,
      name: row.name,
      code: row.code,
      revision: row.revision,
      fields: fields.filter((f) => states[f.field] !== 'hidden'),
      values,
      fieldStates: states,
    };
  }

  /** 只返回经过字段授权与完整表单校验的差量，写入由workflow同事务完成；不复制或覆盖原提交。 */
  async workflowPatch(
    id: string,
    patch: Record<string, unknown>,
    access: Parameters<FormSubmissionService['workflowView']>[1],
    manager: EntityManager,
    validateComplete = true,
  ): Promise<Record<string, unknown>> {
    if (!Object.keys(patch).length) return access.changes;
    if (Buffer.byteLength(JSON.stringify(patch)) > 65536)
      throw crudErrors.badRequest('填写内容最多64KiB');
    const before = await this.workflowView(id, access, manager);
    const view = await this.workflowView(
      id,
      { ...access, changes: { ...access.changes, ...patch } },
      manager,
    );
    for (const key of Object.keys(patch))
      if (
        view.fieldStates[key] !== 'editable' &&
        !(
          view.fieldStates[key] === 'hidden' &&
          before.fieldStates[key] === 'editable' &&
          (patch[key] === null ||
            patch[key] === '' ||
            (Array.isArray(patch[key]) && patch[key].length === 0))
        )
      )
        throw crudErrors.badRequest('只能修改当前节点允许编辑的字段', [
          { field: `values.${key}`, messages: ['该字段不可编辑'] },
        ]);
    const { row, definition } = await this.workflowSnapshot(id, manager);
    const values = { ...row.values, ...access.changes, ...patch };
    if (validateComplete) validateFormValues(definition, values, true);
    return Object.fromEntries(
      Object.entries(values).filter(
        ([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(row.values[key]),
      ),
    );
  }
  protected override async beforeAdd(
    data: Partial<FormSubmission>,
    tx: CrudTx,
  ) {
    if (!data.definitionId || !data.values)
      throw crudErrors.badRequest('请选择表单，并填写有权编辑的内容');
    if (Buffer.byteLength(JSON.stringify(data.values)) > 65536)
      throw crudErrors.badRequest('填写内容最多64KiB');
    const definition = await this.definitions.forSubmission(
      data.definitionId,
      tx.manager,
    );
    validateFormValues(definition, data.values);
    const auth = this.crud.authz.get();
    if (tx.ctx.endpoint !== 'system' && auth)
      for (const key of Object.keys(data.values)) {
        if (
          definition.fields.some(
            (field) => field.field === key && field.generated,
          )
        )
          continue;
        const policy = fieldVerdict(
          auth,
          tx.ctx.userId,
          dynamicFieldResource('form', definition.code),
          FormSubmission,
          key,
          false,
          null,
        );
        if (policy.state !== 'editable')
          throw crudErrors.badRequest('存在没有填写权限的字段', [
            { field: `data.values.${key}`, messages: ['该字段当前不可填写'] },
          ]);
      }
    const fields = definition.fields.filter((f) => f.generated);
    const results = fields.length
      ? await this.codesService.nextManyInTx(
          tx.manager,
          fields.map((f) => ({
            usageKey: fieldUsageKey('form', definition.code, f.field),
            count: 1,
          })),
        )
      : [];
    data.codes = {};
    fields.forEach((field, i) => {
      const value = results[i]!.codes[0]!;
      data.values![field.field] = value;
      data.codes![field.field] = value;
    });
    validateFormValues(definition, data.values, true);
    data.fieldTitles = Object.fromEntries(
      definition.fields.map((f) => [f.field, f.title]),
    );
    data.name = definition.name;
    data.code = definition.code;
    data.revision = definition.revision;
  }
}
