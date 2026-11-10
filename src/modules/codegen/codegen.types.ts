/** 代码生成配置（契约 docs/contracts/codegen.md 第 2 节） */
export type FieldType =
  | 'string'
  | 'int'
  | 'decimal'
  | 'money'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'json';

export const FIELD_TYPES: FieldType[] = [
  'string',
  'int',
  'decimal',
  'money',
  'date',
  'datetime',
  'boolean',
  'json',
];
export const COMPONENTS = [
  'input',
  'textarea',
  'number',
  'select',
  'radio',
  'checkbox',
  'switch',
  'date',
  'image',
  'file',
  'rich',
  'tree-select',
  'relation',
] as const;
export const QUERY_MODES = ['eq', 'like', 'range', 'between', 'in'] as const;

export interface CodegenField {
  name: string;
  column: string;
  label: string;
  type: FieldType;
  length?: number;
  nullable?: boolean;
  list?: boolean;
  query?: (typeof QUERY_MODES)[number] | null;
  form?: boolean;
  required?: boolean;
  unique?: boolean;
  component?: (typeof COMPONENTS)[number];
  dict?: string | null;
  fieldPerm?: { default?: string; mask?: string | null } | null;
}

export interface CodegenChild {
  table: string;
  foreignKey: string;
  label: string;
  fields: CodegenField[];
}

export interface CodegenConfig {
  module: string;
  business: string;
  label: string;
  permPrefix: string;
  table: string;
  template: 'single' | 'tree' | 'master-detail';
  tree?: { parentField: string; nameField: string; sortField?: string } | null;
  children?: CodegenChild[];
  options?: {
    deleteMode?: 'soft' | 'hard';
    formMode?: 'dialog' | 'drawer';
    export?: boolean;
    import?: boolean;
    parentMenuId?: string | null;
    dataScope?: boolean;
  };
  fields: CodegenField[];
}

const SNAKE = /^[a-z][a-z0-9_]{0,62}$/;
const CAMEL = /^[a-z][A-Za-z0-9]{0,62}$/;
const PERM = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/;
/** 生成的代码里不能和基类字段、JS 保留字撞名 */
const RESERVED = new Set([
  'id',
  'tenantId',
  'orgId',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'version',
  'activeGuard',
  'deleteBatch',
  'constructor',
  'prototype',
  '__proto__',
  'class',
  'function',
  'delete',
  'new',
  'return',
  'this',
]);

type Err = { field: string; messages: string[] };

/** 校验生成配置：标识符、类型、组件都走白名单（架构「生成器的安全边界 · 名字和文字要校验」） */
export function validateCodegenConfig(raw: unknown): Err[] {
  const errs: Err[] = [];
  const bad = (field: string, m: string) => errs.push({ field, messages: [m] });
  const c = raw as Partial<CodegenConfig>;
  if (!c || typeof c !== 'object')
    return [{ field: 'config', messages: ['配置必须是对象'] }];
  if (!SNAKE.test(c.module ?? ''))
    bad('module', '模块名只能小写字母、数字、下划线，字母开头');
  if (!SNAKE.test(c.business ?? ''))
    bad('business', '业务名只能小写字母、数字、下划线，字母开头');
  if (!SNAKE.test(c.table ?? ''))
    bad('table', '表名只能小写字母、数字、下划线，字母开头');
  if (!PERM.test(c.permPrefix ?? ''))
    bad('permPrefix', '权限前缀格式：模块:资源，例如 crm:customer');
  if (typeof c.label !== 'string' || !c.label || c.label.length > 30)
    bad('label', '显示名称 1 到 30 字');
  if (!['single', 'tree', 'master-detail'].includes(c.template as string))
    bad('template', '模板只能是 single / tree / master-detail');
  const fields = (list: unknown, path: string) => {
    if (!Array.isArray(list) || list.length === 0 || list.length > 100)
      return bad(path, '字段 1 到 100 个');
    const names = new Set<string>();
    list.forEach((f: Partial<CodegenField>, i) => {
      const p = `${path}[${i}]`;
      if (!CAMEL.test(f?.name ?? '') || RESERVED.has(f.name!))
        bad(`${p}.name`, '属性名要小驼峰，不能和基类字段、保留字同名');
      else if (names.has(f.name!)) bad(`${p}.name`, '属性名重复');
      else names.add(f.name!);
      if (!SNAKE.test(f?.column ?? ''))
        bad(`${p}.column`, '列名只能小写字母、数字、下划线');
      if (typeof f?.label !== 'string' || !f.label || f.label.length > 30)
        bad(`${p}.label`, '显示名称 1 到 30 字');
      if (!FIELD_TYPES.includes(f?.type as FieldType))
        bad(`${p}.type`, '类型不在白名单里');
      if (
        f?.length !== undefined &&
        (!Number.isInteger(f.length) || f.length < 1 || f.length > 4000)
      )
        bad(`${p}.length`, '长度 1 到 4000');
      if (f?.component !== undefined && !COMPONENTS.includes(f.component))
        bad(`${p}.component`, '显示方式不在白名单里');
      if (
        f?.query !== undefined &&
        f.query !== null &&
        !QUERY_MODES.includes(f.query)
      )
        bad(`${p}.query`, '查询方式不在白名单里');
      if (
        f?.dict !== undefined &&
        f.dict !== null &&
        !/^[a-z][a-z0-9_.-]{1,63}$/.test(f.dict)
      )
        bad(
          `${p}.dict`,
          '字典编码须小写字母开头，只能包含小写字母、数字、点、横线和下划线',
        );
    });
  };
  fields(c.fields, 'fields');
  if (
    c.template === 'tree' &&
    (!c.tree ||
      !CAMEL.test(c.tree.parentField) ||
      !CAMEL.test(c.tree.nameField))
  )
    bad('tree', '树表要选父级字段和名称字段');
  if (c.template === 'tree' && c.tree && Array.isArray(c.fields)) {
    const has = (n: string) => c.fields!.some((f) => f?.name === n);
    const parent = c.fields.find((f) => f?.name === c.tree!.parentField);
    if (!parent) bad('tree.parentField', '父级字段要在字段列表里');
    else if (parent.type !== 'int')
      bad(
        'tree.parentField',
        '父级字段类型选整数（生成为 bigint，根节点为空）',
      );
    if (!has(c.tree.nameField)) bad('tree.nameField', '名称字段要在字段列表里');
    if (
      c.tree.sortField !== undefined &&
      (!CAMEL.test(c.tree.sortField) || !has(c.tree.sortField))
    )
      bad('tree.sortField', '排序字段要在字段列表里');
  }
  if (c.template === 'master-detail') {
    if (
      !Array.isArray(c.children) ||
      c.children.length === 0 ||
      c.children.length > 5
    )
      bad('children', '主子表要有 1 到 5 个子表');
    else
      c.children.forEach((ch, i) => {
        if (!SNAKE.test(ch?.table ?? ''))
          bad(`children[${i}].table`, '表名格式不对');
        if (!CAMEL.test(ch?.foreignKey ?? ''))
          bad(`children[${i}].foreignKey`, '关联字段要小驼峰');
        if (typeof ch?.label !== 'string' || !ch.label)
          bad(`children[${i}].label`, '要有显示名称');
        fields(ch?.fields, `children[${i}].fields`);
      });
  }
  return errs;
}

/** 数据库列类型 → 生成器类型 */
export function mapColumnType(dataType: string, columnType: string): FieldType {
  const t = dataType.toLowerCase();
  if (t === 'tinyint' && columnType.toLowerCase().startsWith('tinyint(1)'))
    return 'boolean';
  if (
    ['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint'].includes(t)
  )
    return 'int';
  if (['decimal', 'numeric', 'float', 'double'].includes(t)) return 'decimal';
  if (t === 'date') return 'date';
  if (['datetime', 'timestamp'].includes(t)) return 'datetime';
  if (t === 'json') return 'json';
  if (t === 'bit' || t === 'boolean') return 'boolean';
  return 'string';
}

export const toCamel = (s: string) =>
  s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
