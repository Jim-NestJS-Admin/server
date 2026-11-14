import { AsyncLocalStorage } from 'node:async_hooks';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { CodeUsageRegistry } from '../../code-rule/service/usage-registry.js';
import { fieldUsageKey } from '../../../core/crud/crud-code.js';
import type { EntityManager } from 'typeorm';
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
  constructor(
    private readonly codes: CodeRuleService,
    private readonly repos: TenantRepositoryFactory,
    registry: CodeUsageRegistry,
  ) {
    super();
    registry.addSource('form-fields', async (manager) => {
      const rows = await this.repos
        .for(FormDefinition)
        .query('f', manager)
        .select(['f.code', 'f.name', 'f.fields', 'f.revision'])
        .orderBy('f.revision', 'DESC')
        .getMany();
      const usages = new Map<
        string,
        import('../../code-rule/service/rule-config.js').CodeUsage
      >();
      for (const row of rows)
        for (const field of row.fields.filter((f) => f.generated)) {
          const key = fieldUsageKey('form', row.code, field.field);
          if (!usages.has(key))
            usages.set(key, {
              key,
              name: `${row.name} / ${field.title}`,
              resource: `form/${row.code}`,
              field: field.field,
              maxLength: field.validation.max ?? 64,
              charset: field.codeCharset ?? 'lower_slug',
              uniqueScope: 'tenant',
              allowRuleSwitch: true,
            });
        }
      return [...usages.values()];
    });
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
    this.codes.auditAfterCommit(tx.manager, '保存动态表单编码字段');
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
    if (latest) {
      // 同名字段共享用途；修订不能重新解释既有编号的约束。删除字段不影响历史提交及历史用途。
      const history = await this.repos
        .for(FormDefinition)
        .query('f', tx.manager)
        .andWhere('f.code = :code', { code: data.code })
        .getMany();
      for (const previous of history.flatMap((r) => r.fields)) {
        const next = parsed.fields.find((f) => f.field === previous.field);
        if (
          next &&
          (Boolean(next.generated) !== Boolean(previous.generated) ||
            (next.generated &&
              (next.codeCharset !== previous.codeCharset ||
                next.validation.max !== previous.validation.max)))
        )
          throw crudErrors.badRequest(
            `字段“${next.title}”已有历史版本，自动编号类型、字符集和长度不能改变，请使用新的字段标识`,
          );
      }
    }
    data.revision = expected + 1;
    data.designer = parsed.designer;
    data.fields = parsed.fields;
  }

  protected override async afterAdd(row: FormDefinition, tx: CrudTx) {
    this.codes.auditAfterCommit(
      tx.manager,
      `保存动态表单编码字段（definitionId=${row.id}，revision=${row.revision}）`,
    );
  }

  async fieldsFor(definitionId: string) {
    const row = await this.loadVersion(definitionId);
    return structuredClone(row.fields);
  }

  /** workflow只读取固定表单快照；仍经本服务的数据/字段范围，不跨模块查表。 */
  async forWorkflow(id: string, manager: EntityManager) {
    const row = await this.select(manager, 'info')
      .andWhere('e.id = :id', { id })
      .getOne();
    if (!row || !Array.isArray(this.toRow(row).fields))
      throw crudErrors.notFound();
    return {
      id: row.id,
      code: row.code,
      revision: row.revision,
      fields: structuredClone(row.fields),
    };
  }

  async validateSubmission(definitionId: string, data: unknown) {
    const row = await this.loadVersion(definitionId);
    validateFormValues(row, data);
    return { definitionId: row.id, revision: row.revision, valid: true };
  }

  /** 提交模块调用本服务读取固定版本；与提交接口共用数据范围，绝不由调用方查询定义表。 */
  async forSubmission(id: string, manager: EntityManager) {
    const row = await this.select(manager, 'add')
      .andWhere('e.id = :id', { id })
      .getOne();
    if (!row) throw crudErrors.notFound();
    return row;
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
