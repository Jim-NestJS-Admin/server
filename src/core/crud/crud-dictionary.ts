import type { EntityManager } from 'typeorm';
import type { CrudFieldMeta, DictItem } from './crud-field.decorator.js';
import { crudErrors } from './crud.errors.js';

/** 业务模块提供字典选项，core 不直接依赖字典实体。事务内校验读取最新启用状态。 */
export interface CrudDictionarySource {
  options(code: string, manager?: EntityManager): Promise<DictItem[]>;
}
export async function validateDictionaryValues(
  source: CrudDictionarySource | undefined,
  fields: CrudFieldMeta[],
  values: Record<string, unknown>,
  manager: EntityManager,
  location?: { resource: string; id?: string; clientId?: string },
): Promise<void> {
  for (const field of fields) {
    if (
      !field.dictCode ||
      !(field.property in values) ||
      values[field.property] == null
    )
      continue;
    if (!source) throw crudErrors.badRequest('动态字典未装配');
    const options = await source.options(field.dictCode, manager);
    if (
      !['string', 'number', 'boolean'].includes(
        typeof values[field.property],
      ) ||
      !options.some(
        (item) => String(item.value) === String(values[field.property]),
      )
    )
      throw crudErrors.badRequest('字典值不存在或已停用', [
        {
          ...location,
          field: field.property,
          messages: [`${field.label}必须选择启用中的字典项`],
        },
      ]);
  }
}
