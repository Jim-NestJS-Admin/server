import { FieldPermStateDto, QUERY_OPS } from './crud-query.dto.js';
import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { getMetadataArgsStorage } from 'typeorm';
import type { DictItem, FormComponent } from './crud-field.decorator.js';
import {
  CRUD_APIS,
  type CrudApi,
  type CrudResourceMeta,
  type SortItem,
} from './crud.types.js';

/** 基础字段在页面上的显示名称 */
const BASE_LABELS: Record<string, string> = {
  id: '编号',
  orgId: '所属组织',
  createdBy: '创建人',
  updatedBy: '修改人',
  createdAt: '创建时间',
  updatedAt: '修改时间',
  version: '版本号',
};

export class CrudSchemaColumn {
  @ApiProperty() field: string;
  @ApiProperty() label: string;
  @ApiPropertyOptional() width?: number;
  @ApiProperty() sortable: boolean;
  @ApiPropertyOptional({ description: '字典名，对应 dictionaries 里的键' })
  dict?: string;
  @ApiProperty({
    enum: [
      'text',
      'number',
      'boolean',
      'date',
      'datetime',
      'json',
      'reference',
    ],
    description:
      '显示方式：datetime / date 按本地时间格式化，boolean 显示是 / 否，reference 显示行里 _display 的名称',
  })
  type: CrudColumnType;
  @ApiPropertyOptional({
    description: '默认不显示（用户可以在列设置里打开）：编号、版本号等系统字段',
  })
  hidden?: boolean;
}

export type CrudColumnType =
  'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'json' | 'reference';

/** 系统字段在列表里的顺序（排在业务字段后面）；默认只显示创建时间，其余在列设置里打开 */
const SYSTEM_COLUMN_ORDER = [
  'createdBy',
  'createdAt',
  'updatedBy',
  'updatedAt',
  'orgId',
  'id',
  'version',
];

function columnType(entity: Function, p: string): CrudColumnType {
  if (p === 'createdBy' || p === 'updatedBy' || p === 'orgId')
    return 'reference';
  if (p === 'createdAt' || p === 'updatedAt' || p === 'deletedAt')
    return 'datetime';
  if (p === 'id' || p === 'version') return p === 'id' ? 'text' : 'number';
  const col = columnArgs(entity, p);
  const dbType = typeof col?.options.type === 'string' ? col.options.type : '';
  if (dbType === 'date') return 'date';
  if (dbType === 'json') return 'json';
  const t = Reflect.getMetadata('design:type', entity.prototype, p);
  if (t === Boolean) return 'boolean';
  if (t === Date) return 'datetime';
  if (t === Number) return 'number';
  return 'text';
}

function columnArgs(entity: Function, p: string) {
  const chain: Function[] = [];
  for (
    let c: Function | null = entity;
    c && c !== Function.prototype;
    c = Object.getPrototypeOf(c) as Function | null
  )
    chain.push(c);
  return getMetadataArgsStorage().columns.find(
    (c) => c.propertyName === p && chain.includes(c.target as Function),
  );
}

export class CrudSchemaFormItem {
  @ApiProperty() field: string;
  @ApiProperty() label: string;
  @ApiProperty({
    enum: [
      'input',
      'textarea',
      'number',
      'select',
      'switch',
      'date',
      'datetime',
      'tree-select',
    ],
  })
  component: FormComponent;
  @ApiProperty() required: boolean;
  @ApiPropertyOptional() placeholder?: string;
  @ApiProperty({
    enum: ['both', 'add', 'none'],
    description: 'both：新增和修改都能写；add：只在新增时写；none：只读',
  })
  edit: 'both' | 'add' | 'none';
  @ApiPropertyOptional() dict?: string;
}

export class CrudSchemaQueryItem {
  @ApiProperty() field: string;
  @ApiProperty() label: string;
  @ApiProperty({
    enum: QUERY_OPS,
    isArray: true,
    description: '这个字段可用的运算符',
  })
  operators: string[];
  @ApiProperty({
    enum: ['string', 'number', 'boolean', 'date'],
    description: '值的类型，前端据此选输入控件',
  })
  type: string;
}

export class CrudSchemaDictItem {
  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
  })
  value: string | number | boolean;
  @ApiProperty() label: string;
}

export class CrudSchemaPageAction {
  @ApiProperty({
    type: [String],
    description: '最多能看哪些列；每一行实际状态以接口逐行返回为准',
  })
  readable: string[];
  @ApiProperty({ type: [String] }) sortable: string[];
  @ApiProperty({ type: [String] }) filterable: string[];
  @ApiProperty({ type: [String], description: '搜索框匹配的字段' })
  keyWords: string[];
}

export class CrudSchemaWriteAction {
  @ApiProperty({ type: [String] }) writable: string[];
}

export class CrudSchemaActions {
  @ApiPropertyOptional({ type: CrudSchemaPageAction })
  page?: CrudSchemaPageAction;
  @ApiPropertyOptional({ type: CrudSchemaWriteAction })
  add?: CrudSchemaWriteAction;
  @ApiPropertyOptional({ type: CrudSchemaWriteAction })
  update?: CrudSchemaWriteAction;
}

export class CrudSchemaSort {
  @ApiProperty() field: string;
  @ApiProperty({ enum: ['asc', 'desc'] }) order: 'asc' | 'desc';
}

export class CrudSchemaTree {
  @ApiProperty({ example: 'parentId', description: '指向父节点编号的字段' })
  parentField: string;
  @ApiProperty({ example: 'name', description: '节点显示名称字段' })
  nameField: string;
  @ApiPropertyOptional({ example: 'sort', description: '同级排序字段' })
  sortField?: string;
}

export class CrudSchemaChild {
  @ApiProperty({ example: 'items' }) resource: string;
  @ApiProperty() label: string;
  @ApiProperty() min: number;
  @ApiProperty() max: number;
  @ApiProperty({
    type: 'array',
    items: { type: 'array', items: { type: 'string' } },
    description: '同一张单据里不能重复的字段组',
  })
  unique: string[][];
  @ApiPropertyOptional() sortField?: string;
  @ApiProperty({ type: [CrudSchemaColumn] }) columns: CrudSchemaColumn[];
  @ApiProperty({ type: [CrudSchemaFormItem] }) form: CrudSchemaFormItem[];
  @ApiProperty({ type: CrudSchemaWriteAction }) add: CrudSchemaWriteAction;
  @ApiProperty({ type: CrudSchemaWriteAction }) update: CrudSchemaWriteAction;
}

/**
 * 页面描述 GET /admin/<资源>/schema：前端通用 CRUD 页面据此渲染（架构「通用 CRUD」）。
 * 现在给的是资源定义本身的能力上限；T06 / T16 接入后按当前用户的本次有效角色和字段权限再裁剪。
 */
export class CrudSchema {
  @ApiProperty({ example: 'system/user' }) resource: string;
  @ApiProperty() label: string;
  @ApiProperty({ example: 'system:user', description: '权限码前缀' })
  permPrefix: string;
  @ApiProperty({
    enum: [...CRUD_APIS],
    isArray: true,
  })
  api: CrudApi[];
  @ApiProperty({ enum: ['soft', 'hard'] }) deleteMode: 'soft' | 'hard';
  @ApiProperty({ type: [CrudSchemaColumn] }) columns: CrudSchemaColumn[];
  @ApiProperty({ type: [CrudSchemaFormItem] }) form: CrudSchemaFormItem[];
  @ApiProperty({ type: [CrudSchemaQueryItem] }) query: CrudSchemaQueryItem[];
  @ApiProperty({
    type: 'object',
    additionalProperties: {
      type: 'array',
      items: { $ref: getSchemaPath('CrudSchemaDictItem') },
    },
  })
  dictionaries: Record<string, DictItem[]>;
  @ApiProperty({ type: CrudSchemaActions }) actions: CrudSchemaActions;
  @ApiProperty({ type: [CrudSchemaSort] }) defaultSort: SortItem[];
  @ApiProperty() maxSize: number;
  @ApiProperty({
    type: [CrudSchemaChild],
    description: '子表；没有子表时为空数组',
  })
  children: CrudSchemaChild[];
  @ApiProperty({
    type: CrudSchemaTree,
    nullable: true,
    description: '树形资源配置；不是树时为 null',
  })
  tree: CrudSchemaTree | null;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { $ref: getSchemaPath('FieldPermStateDto') },
    description:
      '每个业务字段在本页面（列表权限的本次有效角色）下的最宽字段权限状态；逐行以 _fieldState 为准',
  })
  fieldPerms?: Record<string, FieldPermStateDto>;
  @ApiPropertyOptional({
    type: Object,
    description:
      '生效的显示配置（代码默认 → 模块配置 → 用户列设置，按字段权限裁剪后），结构见契约 page-config.md 第 2、4 节',
  })
  view?: unknown;
}

export function buildCrudSchema(meta: CrudResourceMeta): CrudSchema {
  const field = (p: string) => meta.fields.find((f) => f.property === p);
  const label = (p: string) => field(p)?.label ?? BASE_LABELS[p] ?? p;
  const dictionaries: Record<string, DictItem[]> = {};
  for (const f of meta.fields) if (f.dict) dictionaries[f.property] = f.dict;

  // 业务字段在前（按实体里的顺序），系统字段在后；系统字段默认只显示资源配置里列出的（默认创建时间）
  const shown = meta.systemColumns;
  const systemLabel = (p: string) =>
    typeof shown[p] === 'string' ? (shown[p] as string) : label(p);
  const business = meta.readable.filter(
    (p) => !SYSTEM_COLUMN_ORDER.includes(p) && field(p)?.list !== false,
  );
  const system = SYSTEM_COLUMN_ORDER.filter((p) => meta.readable.includes(p));
  const columns: CrudSchemaColumn[] = [
    ...business.map((p) => {
      const f = field(p);
      const list = f?.list || undefined;
      return {
        field: p,
        label: label(p),
        ...(list?.width ? { width: list.width } : {}),
        sortable: meta.sortable.includes(p),
        ...(f?.dict ? { dict: p } : {}),
        type: columnType(meta.entity, p),
      };
    }),
    ...system.map((p) => ({
      field: p,
      label: systemLabel(p),
      sortable: meta.sortable.includes(p),
      type: columnType(meta.entity, p),
      ...(shown[p] ? {} : { hidden: true }),
    })),
  ];

  const form: CrudSchemaFormItem[] = meta.fields
    .filter((f) => f.form !== false && (f.edit ?? 'both') !== 'none')
    .map((f) => {
      const cfg = f.form || {};
      return {
        field: f.property,
        label: f.label,
        component:
          cfg.component ??
          (meta.tree?.parentField === f.property
            ? 'tree-select'
            : f.dict
              ? 'select'
              : 'input'),
        required: Boolean(cfg.required),
        ...(cfg.placeholder ? { placeholder: cfg.placeholder } : {}),
        edit: f.edit ?? 'both',
        ...(f.dict ? { dict: f.property } : {}),
      };
    });

  // 可筛选字段和运算符（T18）：文字可以模糊匹配，数字和日期可以比大小和区间
  const query: CrudSchemaQueryItem[] = meta.fieldEq.map((p) => {
    const t = Reflect.getMetadata(
      'design:type',
      meta.entity.prototype,
      p,
    ) as unknown;
    const type =
      t === Number
        ? 'number'
        : t === Boolean
          ? 'boolean'
          : t === Date
            ? 'date'
            : 'string';
    const common = ['eq', 'ne', 'in', 'notIn', 'isNull', 'notNull'];
    const operators =
      type === 'string'
        ? [...common, 'contains', 'startsWith']
        : type === 'boolean'
          ? ['eq', 'ne', 'isNull', 'notNull']
          : [...common, 'gt', 'gte', 'lt', 'lte', 'between'];
    return { field: p, label: label(p), operators, type };
  });

  const actions: CrudSchemaActions = {};
  if (meta.api.includes('page'))
    actions.page = {
      readable: meta.readable,
      sortable: meta.sortable,
      filterable: meta.fieldEq,
      keyWords: meta.keyWords,
    };
  if (meta.api.includes('add')) actions.add = { writable: meta.addable };
  if (meta.api.includes('update'))
    actions.update = { writable: meta.updatable };

  const children: CrudSchemaChild[] = meta.children.map((c) => {
    const cf = (p: string) => c.fields.find((f) => f.property === p);
    for (const f of c.fields)
      if (f.dict) dictionaries[`${c.resource}.${f.property}`] = f.dict;
    return {
      resource: c.resource,
      label: c.label,
      min: c.min,
      max: c.max,
      unique: c.unique,
      ...(c.sortField ? { sortField: c.sortField } : {}),
      columns: c.readable
        .filter((p) => cf(p)?.list !== false)
        .map((p) => {
          const f = cf(p);
          const list = f?.list || undefined;
          return {
            field: p,
            label: f?.label ?? BASE_LABELS[p] ?? p,
            ...(list?.width ? { width: list.width } : {}),
            sortable: false,
            ...(f?.dict ? { dict: `${c.resource}.${p}` } : {}),
            type: columnType(c.entity, p),
            ...(SYSTEM_COLUMN_ORDER.includes(p) ? { hidden: true } : {}),
          };
        }),
      form: c.fields
        .filter((f) => f.form !== false && (f.edit ?? 'both') !== 'none')
        .map((f) => {
          const cfg = f.form || {};
          return {
            field: f.property,
            label: f.label,
            component: cfg.component ?? (f.dict ? 'select' : 'input'),
            required: Boolean(cfg.required),
            ...(cfg.placeholder ? { placeholder: cfg.placeholder } : {}),
            edit: f.edit ?? 'both',
            ...(f.dict ? { dict: `${c.resource}.${f.property}` } : {}),
          };
        }),
      add: { writable: c.addable },
      update: { writable: c.updatable },
    };
  });

  return {
    resource: meta.prefix,
    label: meta.label,
    permPrefix: meta.permPrefix,
    api: meta.api,
    deleteMode: meta.deleteMode,
    columns,
    form,
    query,
    dictionaries,
    actions,
    defaultSort: meta.defaultSort,
    maxSize: meta.maxSize,
    children,
    tree: meta.tree ? { ...meta.tree } : null,
  };
}
