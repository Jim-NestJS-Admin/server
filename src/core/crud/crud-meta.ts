import { getMetadataStorage } from 'class-validator';
import type { BaseEntity } from './base.entity.js';
import { getCrudFields } from './crud-field.decorator.js';
import {
  CRUD_APIS,
  type CrudControllerOptions,
  type CrudResourceMeta,
} from './crud.types.js';

const PREFIX = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+$/;
/** 接口响应里对外的基础字段 */
const BASE_READABLE = [
  'id',
  'version',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
];
const BASE_SORTABLE = ['id', 'createdAt', 'updatedAt'];
export const MAX_PAGE_SIZE = 500;

const pascal = (prefix: string) =>
  prefix
    .split(/[/-]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');

/**
 * 把 @CrudController 的配置和实体上的 @CrudField 整理成资源定义，配置写错在启动时就报错，
 * 不等到请求进来才发现（例如搜索字段写了一个不存在的字段、可写字段没有校验规则）。
 */
export function resolveCrudMeta<T extends BaseEntity>(
  options: CrudControllerOptions<T>,
): CrudResourceMeta<T> {
  const where = `@CrudController({ prefix: '${options.prefix}' })`;
  const fail = (msg: string): never => {
    throw new Error(`${where}：${msg}`);
  };
  if (!PREFIX.test(options.prefix))
    fail('prefix 必须是「模块/资源」形式的小写路径，如 system/user');
  for (const a of options.api)
    if (!CRUD_APIS.includes(a)) fail(`不认识的接口 ${a}`);

  const fields = getCrudFields(options.entity);
  const names = new Set(fields.map((f) => f.property));
  for (const f of fields)
    if (
      BASE_READABLE.includes(f.property) ||
      f.property === 'tenantId' ||
      f.property === 'deletedAt'
    )
      fail(`${f.property} 是框架维护的字段，不能用 @CrudField 声明`);

  const addable = fields
    .filter((f) => (f.edit ?? 'both') !== 'none')
    .map((f) => f.property);
  const updatable = fields
    .filter((f) => (f.edit ?? 'both') === 'both')
    .map((f) => f.property);

  // 可写字段必须有校验规则：否则全局校验管道会把它当成未声明字段拒绝，或者更糟，不校验就入库
  const validated = new Set(
    getMetadataStorage()
      .getTargetValidationMetadatas(options.entity, '', true, false)
      .map((m) => m.propertyName),
  );
  for (const p of addable)
    if (!validated.has(p))
      fail(
        `可写字段 ${p} 没有 class-validator 校验装饰器（不需要校验也要写 @IsOptional() 或具体规则）`,
      );

  const q = options.pageQuery ?? {};
  for (const p of [...(q.keyWords ?? []), ...(q.fieldEq ?? [])])
    if (!names.has(p)) fail(`搜索或筛选字段 ${p} 没有用 @CrudField 声明`);

  const sortable = [
    ...BASE_SORTABLE,
    ...fields.filter((f) => f.list && f.list.sortable).map((f) => f.property),
  ];
  const defaultSort = (q.defaultSort ?? [{ field: 'id', order: 'desc' }]).map(
    (s) => ({
      field: String(s.field),
      order: s.order,
    }),
  );
  for (const s of defaultSort)
    if (!sortable.includes(s.field))
      fail(`默认排序字段 ${s.field} 不在可排序字段里`);

  const maxSize = q.maxSize ?? MAX_PAGE_SIZE;
  if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > MAX_PAGE_SIZE)
    fail(`maxSize 必须在 1 到 ${MAX_PAGE_SIZE} 之间`);

  return {
    prefix: options.prefix,
    label: options.label,
    name: pascal(options.prefix),
    permPrefix: options.prefix.replace(/\//g, ':'),
    entity: options.entity,
    api: [...options.api],
    deleteMode: options.delete ?? 'soft',
    fields,
    addable,
    updatable,
    readable: [...BASE_READABLE, ...fields.map((f) => f.property)],
    sortable,
    keyWords: [...(q.keyWords ?? [])],
    fieldEq: [...(q.fieldEq ?? [])],
    defaultSort,
    maxSize,
  };
}
