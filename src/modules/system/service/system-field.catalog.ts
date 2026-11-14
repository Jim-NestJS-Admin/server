import { Inject, Injectable } from '@nestjs/common';
import { CrudRuntime } from '../../../core/crud/crud.runtime.js';
import { SYSTEM_FIELDS } from '../../../core/crud/base.entity.js';
import {
  fieldPermOf,
  STATE_RANK,
  type FieldState,
} from '../../../core/field-perm/field-perm.decorator.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { SystemField } from '../entity/system-field.entity.js';
import type { EntityManager } from 'typeorm';
import type { DynamicFieldResource } from '../../../core/field-perm/dynamic-fields.js';

const SYSTEM = new Set<string>([...SYSTEM_FIELDS, 'version', 'deletedAt']);
@Injectable()
export class SystemFieldCatalog {
  @Inject(TenantRepositoryFactory)
  private readonly repos!: TenantRepositoryFactory;
  constructor(private readonly runtime: CrudRuntime) {}
  dynamic(manager?: EntityManager): Promise<DynamicFieldResource[]> {
    return this.runtime.dynamicFields?.(manager) ?? Promise.resolve([]);
  }
  findWithDynamic(
    resource: string,
    field: string,
    dynamic: DynamicFieldResource[],
  ) {
    return (
      this.find(resource, field) ??
      dynamic
        .find((r) => r.resource === resource)
        ?.fields.find((f) => f.field === field && f.configurable)
    );
  }
  async resolve(resource: string, field: string, manager?: EntityManager) {
    return (
      this.find(resource, field) ??
      this.findWithDynamic(resource, field, await this.dynamic(manager))
    );
  }
  async validateAsync(
    resource: string,
    field: string,
    state: FieldState,
    mask: string | null | undefined,
    delegable?: FieldState | null,
    manager?: EntityManager,
  ) {
    const code = await this.resolve(resource, field, manager);
    if (!code) throw crudErrors.badRequest('资源字段不存在或不允许配置');
    if (state === 'masked' && !mask && !code.mask)
      throw crudErrors.badRequest('脱敏状态必须指定规则');
    if (
      delegable &&
      (!code.delegable || STATE_RANK[delegable] > STATE_RANK[code.delegable])
    )
      throw crudErrors.badRequest('可委派上限不能超过代码声明');
    return code;
  }
  async delegationMatrix(resource: string, manager: EntityManager) {
    const declaration = (await this.dynamic(manager)).find(
      (r) => r.resource === resource,
    );
    const rows = await this.repos
      .for(SystemField)
      .query('f', manager)
      .andWhere('f.resource = :resource AND f.enabled = :enabled', {
        resource,
        enabled: true,
      })
      .setLock('pessimistic_read')
      .getMany();
    return Object.fromEntries(
      (declaration?.fields ?? []).map((field) => {
        const row = rows.find((r) => r.field === field.field);
        const hard = field.delegable ?? 'hidden';
        const configured = row ? (row.delegable ?? 'hidden') : hard;
        return [
          field.field,
          {
            cap: STATE_RANK[hard] < STATE_RANK[configured] ? hard : configured,
            mask: row?.mask ?? field.mask ?? ('all' as const),
          },
        ];
      }),
    );
  }

  /** 流程字段临时授权只可收紧代码声明，模块配置显式清空上限时拒绝委派。 */
  async delegationLimit(
    resource: string,
    field: string,
    manager: EntityManager,
  ): Promise<FieldState> {
    const code = this.find(resource, field);
    if (!code?.delegable) return 'hidden';
    const row = await this.repos
      .for(SystemField)
      .query('f', manager)
      .andWhere(
        'f.resource = :resource AND f.field = :field AND f.enabled = :enabled',
        { resource, field, enabled: true },
      )
      .setLock('pessimistic_read')
      .getOne();
    const limit = row ? (row.delegable ?? 'hidden') : code.delegable;
    return STATE_RANK[limit] < STATE_RANK[code.delegable]
      ? limit
      : code.delegable;
  }
  find(resource: string, field: string) {
    const meta = this.runtime
      .list()
      .find((item) => item.permPrefix === resource);
    if (
      !meta ||
      SYSTEM.has(field) ||
      !meta.fields.some((item) => item.property === field)
    )
      return;
    const code = fieldPermOf(meta.entity, field);
    if (code?.configurable === false) return;
    return {
      default: code?.default ?? 'editable',
      mask: code?.mask ?? null,
      delegable: code?.delegable ?? null,
    };
  }
  validate(
    resource: string,
    field: string,
    state: FieldState,
    mask: string | null | undefined,
    delegable?: FieldState | null,
  ) {
    const code = this.find(resource, field);
    if (!code) throw crudErrors.badRequest('资源字段不存在或不允许配置');
    if (state === 'masked' && !mask && !code.mask)
      throw crudErrors.badRequest('脱敏状态必须指定规则');
    if (
      delegable &&
      (!code.delegable || STATE_RANK[delegable] > STATE_RANK[code.delegable])
    )
      throw crudErrors.badRequest('可委派上限不能超过代码声明');
    return code;
  }
}
