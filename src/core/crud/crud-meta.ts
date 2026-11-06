import { getMetadataStorage } from 'class-validator';
import { getMetadataArgsStorage } from 'typeorm';
import { BaseEntity } from './base.entity.js';
import { getCrudFields } from './crud-field.decorator.js';
import {
  CRUD_APIS,
  type CrudChildMeta,
  type CrudChildOptions,
  type CrudControllerOptions,
  type CrudResourceMeta,
} from './crud.types.js';

const PREFIX = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+$/;
/** 接口响应里对外的基础字段 */
const BASE_READABLE = [
  'id',
  'version',
  'orgId',
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

/** 子表每行对外的基础字段：子表不单独做并发控制，不暴露版本号 */
const CHILD_BASE_READABLE = [
  'id',
  'orgId',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
];
const CHILD_RESOURCE = /^[a-z][a-zA-Z0-9]*$/;
export const MAX_CHILD_ROWS = 1000;

const FRAMEWORK_FIELDS = new Set([
  ...BASE_READABLE,
  'tenantId',
  'deletedAt',
  'activeGuard',
  'deleteBatch',
]);

function validatedProps(entity: Function): Set<string> {
  return new Set(
    getMetadataStorage()
      .getTargetValidationMetadatas(entity, '', true, false)
      .map((m) => m.propertyName),
  );
}

/** 实体（含父类）上用 TypeORM 声明过的列 */
function columnProps(entity: Function): Set<string> {
  const chain: Function[] = [];
  for (
    let c: Function | null = entity;
    c && c !== Function.prototype;
    c = Object.getPrototypeOf(c) as Function | null
  )
    chain.push(c);
  return new Set(
    getMetadataArgsStorage()
      .columns.filter((c) => chain.includes(c.target as Function))
      .map((c) => c.propertyName),
  );
}

function resolveChild(
  c: CrudChildOptions,
  parent: string,
  fail: (msg: string) => never,
): CrudChildMeta {
  const at = `子表 ${c.resource}`;
  if (!CHILD_RESOURCE.test(c.resource))
    fail(`${at}：resource 必须是小写字母开头的驼峰名，如 items`);
  if (!(c.entity.prototype instanceof BaseEntity))
    fail(`${at}：实体必须继承 BaseEntity`);
  const fields = getCrudFields(c.entity);
  for (const f of fields)
    if (FRAMEWORK_FIELDS.has(f.property))
      fail(`${at}：${f.property} 是框架维护的字段，不能用 @CrudField 声明`);
  const columns = columnProps(c.entity);
  if (!columns.has(c.foreignKey))
    fail(`${at}：外键 ${c.foreignKey} 不是实体上的列`);
  if (fields.some((f) => f.property === c.foreignKey))
    fail(
      `${at}：外键 ${c.foreignKey} 由框架填写，不能用 @CrudField 声明（否则前端能改它，把明细挂到别的单据上）`,
    );
  const addable = fields
    .filter((f) => (f.edit ?? 'both') !== 'none')
    .map((f) => f.property);
  const updatable = fields
    .filter((f) => (f.edit ?? 'both') === 'both')
    .map((f) => f.property);
  const validated = validatedProps(c.entity);
  for (const p of addable)
    if (!validated.has(p))
      fail(`${at}：可写字段 ${p} 没有 class-validator 校验装饰器`);
  const names = new Set(fields.map((f) => f.property));
  const unique = c.unique ?? [];
  for (const group of unique) {
    if (!group.length) fail(`${at}：unique 里不能有空组`);
    for (const p of group)
      if (!names.has(p)) fail(`${at}：唯一字段 ${p} 没有用 @CrudField 声明`);
  }
  if (c.sortField && !columns.has(c.sortField))
    fail(`${at}：排序字段 ${c.sortField} 不是实体上的列`);
  const min = c.min ?? 0;
  const max = c.max ?? 500;
  if (
    !Number.isInteger(min) ||
    !Number.isInteger(max) ||
    min < 0 ||
    max < 1 ||
    min > max ||
    max > MAX_CHILD_ROWS
  )
    fail(`${at}：行数限制必须满足 0 ≤ min ≤ max ≤ ${MAX_CHILD_ROWS}`);
  return {
    resource: c.resource,
    label: c.label,
    name: `${parent}${c.resource.charAt(0).toUpperCase()}${c.resource.slice(1)}`,
    entity: c.entity,
    foreignKey: c.foreignKey,
    fields,
    addable,
    updatable,
    readable: [...CHILD_BASE_READABLE, ...fields.map((f) => f.property)],
    min,
    max,
    unique: unique.map((g) => [...g]),
    ...(c.sortField ? { sortField: c.sortField } : {}),
  };
}

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
    if (FRAMEWORK_FIELDS.has(f.property))
      fail(`${f.property} 是框架维护的字段，不能用 @CrudField 声明`);

  const deleteMode = options.delete ?? 'soft';
  const recycleApis = options.api.filter(
    (a) => a === 'recycle' || a === 'restore' || a === 'purge',
  );
  if (deleteMode === 'hard' && recycleApis.length)
    fail(`硬删除的资源没有回收站，不能开放 ${recycleApis.join('、')}`);

  const addable = fields
    .filter((f) => (f.edit ?? 'both') !== 'none')
    .map((f) => f.property);
  const updatable = fields
    .filter((f) => (f.edit ?? 'both') === 'both')
    .map((f) => f.property);

  // 可写字段必须有校验规则：否则全局校验管道会把它当成未声明字段拒绝，或者更糟，不校验就入库
  const validated = validatedProps(options.entity);
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

  const name = pascal(options.prefix);
  const children = (options.children ?? []).map((c) =>
    resolveChild(c, name, fail),
  );
  const seen = new Set<string>();
  for (const c of children) {
    if (seen.has(c.resource)) fail(`子表 ${c.resource} 重复`);
    seen.add(c.resource);
    if (c.entity === (options.entity as Function))
      fail(`子表 ${c.resource} 不能和主表是同一个实体`);
  }
  if (new Set(children.map((c) => c.entity)).size !== children.length)
    fail('同一个子表实体只能挂一次');

  return {
    prefix: options.prefix,
    label: options.label,
    name,
    permPrefix: options.prefix.replace(/\//g, ':'),
    dataScope: options.dataScope ?? false,
    entity: options.entity,
    api: [...options.api],
    deleteMode,
    fields,
    addable,
    updatable,
    readable: [...BASE_READABLE, ...fields.map((f) => f.property)],
    sortable,
    keyWords: [...(q.keyWords ?? [])],
    fieldEq: [...(q.fieldEq ?? [])],
    defaultSort,
    maxSize,
    children,
  };
}
