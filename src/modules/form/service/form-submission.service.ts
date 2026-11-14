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
@Injectable()
export class FormSubmissionService extends BaseService<FormSubmission> {
  constructor(
    private readonly definitions: FormDefinitionService,
    private readonly codesService: CodeRuleService,
  ) {
    super();
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
