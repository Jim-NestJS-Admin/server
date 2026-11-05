import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { DictItem, FormComponent } from './crud-field.decorator.js';
import type { CrudApi, CrudResourceMeta, SortItem } from './crud.types.js';

/** 基础字段在页面上的显示名称 */
const BASE_LABELS: Record<string, string> = {
  id: '编号',
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
    type: [String],
    description: '可用的运算符；高级查询在 T18 扩展',
  })
  operators: string[];
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
    enum: ['page', 'info', 'add', 'update', 'delete'],
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
      items: { $ref: '#/components/schemas/CrudSchemaDictItem' },
    },
  })
  dictionaries: Record<string, DictItem[]>;
  @ApiProperty({ type: CrudSchemaActions }) actions: CrudSchemaActions;
  @ApiProperty({ type: [CrudSchemaSort] }) defaultSort: SortItem[];
  @ApiProperty() maxSize: number;
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

  const query: CrudSchemaQueryItem[] = meta.fieldEq.map((p) => ({
    field: p,
    label: label(p),
    operators: ['eq'],
  }));

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
  };
}
