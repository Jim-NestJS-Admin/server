import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { BaseService } from '../../../core/crud/base.service.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import type { CrudTx } from '../../../core/crud/crud.types.js';
import type { FormDefinitionInput } from '../dto/form.dto.js';
import { FormDefinition } from '../entity/form-definition.entity.js';
import { parseFormDesigner, validateFormValues } from './form-rules.js';
import { CodeRuleService } from '../../code-rule/service/code-rule.service.js';

@Injectable()
export class FormDefinitionService extends BaseService<FormDefinition> {
  private readonly saving = new AsyncLocalStorage<{
    expected: number;
    code?: string;
  }>();
  constructor(private readonly codes: CodeRuleService) {
    super();
  }

  createDefinition(data: FormDefinitionInput) {
    return this.saving.run({ expected: 0 }, () => super.add(data));
  }
  async reviseDefinition(
    data: FormDefinitionInput,
    baseRevision: number,
    definitionId: string,
  ) {
    const original = await this.loadVersion(definitionId);
    return this.saving.run(
      { expected: baseRevision, code: original.code },
      () => super.add(data),
    );
  }

  protected override async beforeAdd(
    data: Partial<FormDefinition>,
    tx: CrudTx,
  ) {
    const saving = this.saving.getStore();
    if (!saving) throw crudErrors.badRequest('请使用表单创建或修订接口');
    const expected = saving.expected;
    if (!data.name || !data.designer)
      throw crudErrors.badRequest('缺少可写的表单编码、名称或设计');
    const parsed = parseFormDesigner(data.designer);
    data.code =
      expected === 0
        ? (await this.codes.nextInTx(tx.manager, 'form_definition_code'))
            .codes[0]!
        : saving.code!;
    // 第一版是该编码永久存在的互斥行；所有修订按同一顺序加锁，旧版本不更新不删除。
    const first = await this.select(tx.manager, 'add')
      .andWhere('e.code = :code AND e.revision = 1', { code: data.code })
      .setLock('pessimistic_write')
      .getOne();
    if (!first && expected > 0) throw crudErrors.notFound();
    if (first && expected === 0)
      throw crudErrors.badRequest('表单编码已存在', [
        { field: 'data.code', messages: ['表单编码已存在，请创建新版本'] },
      ]);
    const latest = first
      ? await this.select(tx.manager, 'add')
          .andWhere('e.code = :code', { code: data.code })
          .orderBy('e.revision', 'DESC')
          .setLock('pessimistic_write')
          .getOne()
      : null;
    if ((latest?.revision ?? 0) !== expected)
      throw crudErrors.versionConflict();
    data.revision = expected + 1;
    data.designer = parsed.designer;
    data.fields = parsed.fields;
  }

  async fieldsFor(definitionId: string) {
    const row = await this.loadVersion(definitionId);
    return structuredClone(row.fields);
  }

  async validateSubmission(definitionId: string, data: unknown) {
    const row = await this.loadVersion(definitionId);
    validateFormValues(row, data);
    return { definitionId: row.id, revision: row.revision, valid: true };
  }

  private async loadVersion(id: string) {
    const row = await this.select(this.crud.dataSource.manager, 'info')
      .andWhere('e.id = :id', { id })
      .getOne();
    if (!row) throw crudErrors.notFound();
    return row;
  }

  protected override async beforeUpdate(): Promise<void> {
    throw crudErrors.badRequest('历史表单版本不可修改，请创建新版本');
  }
  protected override async beforeDelete(): Promise<void> {
    throw crudErrors.badRequest('历史表单版本不可删除');
  }
}
