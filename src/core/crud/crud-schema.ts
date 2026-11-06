import { FieldPermStateDto, QUERY_OPS } from './crud-query.dto.js';
import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
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

  const columns: CrudSchemaColumn[] = meta.readable
    .filter((p) => field(p)?.list !== false)
    .map((p) => {
      const f = field(p);
      const list = f?.list || undefined;
      return {
        field: p,
        label: label(p),
        ...(list?.width ? { width: list.width } : {}),
        sortable: meta.sortable.includes(p),
        ...(f?.dict ? { dict: p } : {}),
      };
    });

  const form: CrudSchemaFormItem[] = meta.fields
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
  };
}
