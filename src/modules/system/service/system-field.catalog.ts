import { Injectable } from '@nestjs/common';
import { CrudRuntime } from '../../../core/crud/crud.runtime.js';
import { SYSTEM_FIELDS } from '../../../core/crud/base.entity.js';
import {
  fieldPermOf,
  STATE_RANK,
  type FieldState,
} from '../../../core/field-perm/field-perm.decorator.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';

const SYSTEM = new Set<string>([...SYSTEM_FIELDS, 'version', 'deletedAt']);
@Injectable()
export class SystemFieldCatalog {
  constructor(private readonly runtime: CrudRuntime) {}
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
