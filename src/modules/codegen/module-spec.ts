import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  validateCodegenConfig,
  type CodegenConfig,
  type CodegenField,
} from './codegen.types.js';

export const FIELD_CATALOG = [
  {
    type: 'string',
    label: '文本',
    databaseType: 'varchar',
    defaultLength: 255,
    component: 'input',
    options: ['length'],
  },
  {
    type: 'text',
    label: '长文本',
    databaseType: 'text',
    component: 'textarea',
    options: [],
  },
  {
    type: 'int',
    label: '整数',
    databaseType: 'int',
    component: 'number',
    options: [],
  },
  {
    type: 'decimal',
    label: '小数',
    databaseType: 'decimal',
    precision: 14,
    scale: 4,
    component: 'number',
    options: ['precision', 'scale'],
  },
  {
    type: 'money',
    label: '金额',
    databaseType: 'decimal',
    precision: 14,
    scale: 2,
    component: 'number',
    options: ['precision', 'scale'],
  },
  {
    type: 'date',
    label: '日期',
    databaseType: 'date',
    component: 'date',
    options: [],
  },
  {
    type: 'datetime',
    label: '日期时间',
    databaseType: 'datetime',
    component: 'datetime',
    options: [],
  },
  {
    type: 'boolean',
    label: '布尔',
    databaseType: 'boolean',
    component: 'switch',
    options: [],
  },
  {
    type: 'json',
    label: 'JSON',
    databaseType: 'json',
    component: 'input',
    options: [],
  },
  {
    type: 'dictionary',
    label: '字典',
    databaseType: 'varchar',
    defaultLength: 255,
    component: 'select',
    options: ['length', 'dictCode'],
  },
  {
    type: 'reference',
    label: '关联编号',
    databaseType: 'bigint',
    component: 'input',
    options: [],
  },
  {
    type: 'image',
    label: '图片',
    databaseType: 'varchar',
    defaultLength: 2048,
    component: 'input',
    options: ['length'],
  },
  {
    type: 'file',
    label: '文件',
    databaseType: 'varchar',
    defaultLength: 2048,
    component: 'input',
    options: ['length'],
  },
] as const;
export type SpecFieldType = (typeof FIELD_CATALOG)[number]['type'];
export class SpecFieldPerm {
  @ApiProperty({ enum: ['editable', 'readonly', 'masked', 'hidden'] })
  default!: 'editable' | 'readonly' | 'masked' | 'hidden';
  @ApiPropertyOptional({ enum: ['phone', 'email', 'idcard', 'last4', 'all'] })
  mask?: 'phone' | 'email' | 'idcard' | 'last4' | 'all';
}
export class SpecField {
  @ApiProperty() property!: string;
  @ApiProperty() column!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: FIELD_CATALOG.map((t) => t.type) }) type!: SpecFieldType;
  @ApiPropertyOptional() length?: number;
  @ApiPropertyOptional() precision?: number;
  @ApiPropertyOptional() scale?: number;
  @ApiPropertyOptional() nullable?: boolean;
  @ApiPropertyOptional({
    oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
    nullable: true,
  })
  defaultValue?: string | number | boolean | null;
  @ApiPropertyOptional() comment?: string;
  @ApiPropertyOptional() unique?: boolean;
  @ApiPropertyOptional() dictCode?: string;
  @ApiPropertyOptional({ type: SpecFieldPerm }) fieldPerm?: SpecFieldPerm;
}
export class SpecChild {
  @ApiProperty() tableName!: string;
  @ApiProperty({
    description: '由框架维护的外键属性，不得同时出现在 fields 中',
  })
  foreignKey!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: [SpecField] }) fields!: SpecField[];
}
export class SpecTree {
  @ApiProperty() parentField!: string;
  @ApiProperty() nameField!: string;
  @ApiPropertyOptional() sortField?: string;
}
export class SpecOptions {
  @ApiPropertyOptional({ enum: ['soft', 'hard'] }) deleteMode?: 'soft' | 'hard';
  @ApiPropertyOptional() scopeEnabled?: boolean;
  @ApiPropertyOptional() exportEnabled?: boolean;
}
export class ModuleSpec {
  @ApiProperty({ enum: [1] }) version!: 1;
  @ApiProperty() moduleName!: string;
  @ApiProperty() businessName!: string;
  @ApiProperty() title!: string;
  @ApiProperty() permissionPrefix!: string;
  @ApiProperty() tableName!: string;
  @ApiProperty({ enum: ['single', 'tree', 'masterDetail'] }) template!:
    'single' | 'tree' | 'masterDetail';
  @ApiPropertyOptional({ type: SpecTree }) tree?: SpecTree;
  @ApiPropertyOptional({ type: [SpecChild] }) children?: SpecChild[];
  @ApiPropertyOptional({ type: SpecOptions }) options?: SpecOptions;
  @ApiProperty({ type: [SpecField] }) fields!: SpecField[];
}
export class SpecError {
  @ApiProperty() path!: string;
  @ApiProperty() message!: string;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const baseColumns = new Set([
  'id',
  'tenant_id',
  'org_id',
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
  'deleted_at',
  'version',
  'active_guard',
  'delete_batch',
]);
const identifier = /^[a-z][a-z0-9_]{0,47}$/;
const property = /^[a-z][A-Za-z0-9]{0,47}$/;
const forbidden = new Set([
  'constructor',
  'prototype',
  '__proto__',
  'class',
  'function',
  'delete',
  'new',
  'return',
  'this',
  'default',
  'switch',
  'var',
  'let',
  'const',
  'export',
  'import',
  'extends',
  'super',
  'enum',
  'await',
  'yield',
  'null',
  'true',
  'false',
  'interface',
  'implements',
  'private',
  'protected',
  'public',
  'static',
  'package',
]);

/** 严格校验原始 JSON，未知字段和表达式默认值均拒绝，错误直接定位单元格。 */
export function validateSpec(raw: unknown): SpecError[] {
  const errors: SpecError[] = [];
  const bad = (path: string, message: string) => {
    errors.push({ path, message });
  };
  const keys = (
    v: unknown,
    allowed: string[],
    path: string,
  ): v is Record<string, unknown> => {
    if (!object(v)) {
      bad(path, '必须是对象');
      return false;
    }
    for (const key of Object.keys(v))
      if (!allowed.includes(key))
        bad(path ? `${path}.${key}` : key, '未知字段');
    return true;
  };
  const text = (v: unknown, path: string, max: number) => {
    if (
      typeof v !== 'string' ||
      !v.trim() ||
      v.length > max ||
      v
        .split('')
        .some(
          (char) =>
            char.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(char),
        )
    )
      bad(path, `必须是 1 到 ${max} 字的文字`);
  };
  const fields = (v: unknown, path: string, fk?: string) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > 100) {
      bad(path, '字段必须有 1 到 100 个');
      return;
    }
    const names = new Set<string>();
    const columns = new Set<string>();
    v.forEach((f: unknown, i) => {
      const p = `${path}[${i}]`;
      if (
        !keys(
          f,
          [
            'property',
            'column',
            'label',
            'type',
            'length',
            'precision',
            'scale',
            'nullable',
            'defaultValue',
            'comment',
            'unique',
            'dictCode',
            'fieldPerm',
          ],
          p,
        )
      )
        return;
      const prop = f.property;
      const col = f.column;
      const snake =
        typeof prop === 'string'
          ? prop.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
          : '';
      if (
        typeof prop !== 'string' ||
        !property.test(prop) ||
        forbidden.has(prop) ||
        baseColumns.has(snake) ||
        prop === fk ||
        names.has(prop)
      )
        bad(`${p}.property`, '属性名无效、保留或重复（外键由框架维护）');
      else names.add(prop);
      if (
        typeof col !== 'string' ||
        !identifier.test(col) ||
        baseColumns.has(col) ||
        columns.has(col) ||
        col === fk?.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
      )
        bad(`${p}.column`, '列名无效、保留或重复');
      else columns.add(col);
      text(f.label, `${p}.label`, 30);
      const type = FIELD_CATALOG.find((t) => t.type === f.type);
      if (!type) bad(`${p}.type`, '不支持的字段类型');
      if (
        f.length !== undefined &&
        (!['string', 'dictionary', 'image', 'file'].includes(String(f.type)) ||
          !Number.isInteger(f.length) ||
          Number(f.length) < 1 ||
          Number(f.length) > 4000)
      )
        bad(`${p}.length`, '文本长度必须是 1 到 4000 的整数');
      const numeric = f.type === 'decimal' || f.type === 'money';
      if (
        f.precision !== undefined &&
        (!numeric ||
          !Number.isInteger(f.precision) ||
          Number(f.precision) < 1 ||
          Number(f.precision) > 65)
      )
        bad(`${p}.precision`, '精度必须是 1 到 65 的整数，且只适用于小数/金额');
      const scale = f.scale ?? (f.type === 'money' ? 2 : 4);
      if (
        f.scale !== undefined &&
        (!numeric ||
          !Number.isInteger(scale) ||
          Number(scale) < 0 ||
          Number(scale) > 30 ||
          Number(scale) > Number(f.precision ?? 14))
      )
        bad(`${p}.scale`, '小数位必须为 0 到 30 且不超过精度');
      if (numeric && Number(scale) > Number(f.precision ?? 14))
        bad(`${p}.precision`, '精度不能小于小数位');
      for (const k of ['nullable', 'unique'])
        if (f[k] !== undefined && typeof f[k] !== 'boolean')
          bad(`${p}.${k}`, '必须是布尔值');
      if (
        f.comment !== undefined &&
        (typeof f.comment !== 'string' || f.comment.length > 500)
      )
        bad(`${p}.comment`, '注释最多 500 字');
      if (
        f.dictCode !== undefined &&
        (typeof f.dictCode !== 'string' ||
          !/^[a-z][a-z0-9_.-]{1,63}$/.test(f.dictCode))
      )
        bad(`${p}.dictCode`, '字典编码格式无效');
      if (f.type === 'dictionary' && !f.dictCode)
        bad(`${p}.dictCode`, '字典类型必须指定字典编码');
      if (
        f.unique &&
        ['string', 'dictionary', 'image', 'file'].includes(String(f.type)) &&
        Number(
          f.length ?? (f.type === 'image' || f.type === 'file' ? 2048 : 255),
        ) > 765
      )
        bad(`${p}.unique`, 'utf8mb4 唯一索引文本长度不能超过 765');
      if (f.unique && ['text', 'json'].includes(String(f.type)))
        bad(`${p}.unique`, '长文本和 JSON 不支持唯一索引');
      if (
        f.fieldPerm !== undefined &&
        keys(f.fieldPerm, ['default', 'mask'], `${p}.fieldPerm`)
      ) {
        if (
          !['editable', 'readonly', 'masked', 'hidden'].includes(
            String(f.fieldPerm.default),
          )
        )
          bad(`${p}.fieldPerm.default`, '字段权限状态无效');
        if (
          f.fieldPerm.mask !== undefined &&
          !['phone', 'email', 'idcard', 'last4', 'all'].includes(
            typeof f.fieldPerm.mask === 'string' ? f.fieldPerm.mask : '',
          )
        )
          bad(`${p}.fieldPerm.mask`, '脱敏规则无效');
      }
      if (Object.hasOwn(f, 'defaultValue')) {
        const d = f.defaultValue;
        let valid =
          d === null
            ? f.nullable === true
            : typeof d === 'string' ||
              typeof d === 'number' ||
              typeof d === 'boolean';
        if (d !== null) {
          if (f.type === 'int')
            valid =
              typeof d === 'number' &&
              Number.isSafeInteger(d) &&
              d >= -2147483648 &&
              d <= 2147483647;
          else if (numeric) {
            const match = /^-?(\d+)(?:\.(\d+))?$/.exec(
              typeof d === 'string' || typeof d === 'number' ? String(d) : '',
            );
            valid =
              (typeof d === 'string' || typeof d === 'number') &&
              !!match &&
              match[1].length <= Number(f.precision ?? 14) - Number(scale) &&
              (match[2]?.length ?? 0) <= Number(scale);
          } else if (f.type === 'boolean') valid = typeof d === 'boolean';
          else if (f.type === 'json' || f.type === 'text') valid = false;
          else if (f.type === 'date')
            valid =
              typeof d === 'string' &&
              /^\d{4}-\d{2}-\d{2}$/.test(d) &&
              !Number.isNaN(Date.parse(d)) &&
              new Date(d).toISOString().slice(0, 10) === d;
          else if (f.type === 'datetime')
            valid =
              typeof d === 'string' &&
              /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d) &&
              !Number.isNaN(Date.parse(d.replace(' ', 'T') + 'Z')) &&
              new Date(d.replace(' ', 'T') + 'Z')
                .toISOString()
                .slice(0, 19)
                .replace('T', ' ') === d;
          else if (f.type === 'reference')
            valid = typeof d === 'string' && /^[1-9]\d{0,19}$/.test(d);
          else
            valid =
              typeof d === 'string' &&
              d.length <=
                Number(
                  f.length ??
                    (f.type === 'image' || f.type === 'file' ? 2048 : 255),
                );
        }
        if (!valid)
          bad(
            `${p}.defaultValue`,
            '默认值必须是符合字段类型的常量；长文本/JSON 不支持非空默认值',
          );
      }
    });
  };
  if (
    !keys(
      raw,
      [
        'version',
        'moduleName',
        'businessName',
        'title',
        'permissionPrefix',
        'tableName',
        'template',
        'tree',
        'children',
        'options',
        'fields',
      ],
      '',
    )
  )
    return errors;
  if (raw.version !== 1) bad('version', '仅支持 ModuleSpec v1');
  for (const k of ['moduleName', 'businessName', 'tableName'])
    if (
      typeof raw[k] !== 'string' ||
      !identifier.test(raw[k] as string) ||
      forbidden.has(raw[k] as string)
    )
      bad(k, '标识符只能小写字母开头，包含字母、数字和下划线，最多 48 字');
  if (typeof raw.tableName === 'string' && raw.tableName.startsWith('sys_'))
    bad('tableName', '系统表不能作为生成目标');
  text(raw.title, 'title', 30);
  if (
    typeof raw.permissionPrefix !== 'string' ||
    !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(raw.permissionPrefix) ||
    raw.permissionPrefix.length > 100
  )
    bad('permissionPrefix', '权限前缀必须为 模块:资源');
  if (!['single', 'tree', 'masterDetail'].includes(String(raw.template)))
    bad('template', '模板无效');
  fields(raw.fields, 'fields');
  if (
    raw.options !== undefined &&
    keys(
      raw.options,
      ['deleteMode', 'scopeEnabled', 'exportEnabled'],
      'options',
    )
  ) {
    if (
      raw.options.deleteMode !== undefined &&
      !['soft', 'hard'].includes(
        typeof raw.options.deleteMode === 'string'
          ? raw.options.deleteMode
          : '',
      )
    )
      bad('options.deleteMode', '删除方式无效');
    for (const k of ['scopeEnabled', 'exportEnabled'])
      if (raw.options[k] !== undefined && typeof raw.options[k] !== 'boolean')
        bad(`options.${k}`, '必须是布尔值');
  }
  if (raw.template === 'tree') {
    if (keys(raw.tree, ['parentField', 'nameField', 'sortField'], 'tree')) {
      for (const k of [
        'parentField',
        'nameField',
        ...(raw.tree.sortField !== undefined ? ['sortField'] : []),
      ]) {
        const f = Array.isArray(raw.fields)
          ? (raw.fields.find(
              (f: unknown) =>
                object(f) &&
                f.property === (raw.tree as Record<string, unknown>)[k],
            ) as SpecField | undefined)
          : undefined;
        if (!f) bad(`tree.${k}`, '必须选择字段列表中存在的属性');
        else if (k === 'parentField' && !['int', 'reference'].includes(f.type))
          bad(`tree.${k}`, '父级字段必须为整数或关联编号');
        else if (k === 'sortField' && f.type !== 'int')
          bad(`tree.${k}`, '排序字段必须为整数');
        else if (k === 'nameField' && f.type !== 'string')
          bad(`tree.${k}`, '名称字段必须为文本');
      }
      const values = Object.values(raw.tree);
      if (new Set(values).size !== values.length)
        bad('tree', '树形字段不能重复');
    }
  } else if (raw.tree !== undefined) bad('tree', '仅树表允许树形配置');
  if (raw.template === 'masterDetail') {
    if (
      !Array.isArray(raw.children) ||
      raw.children.length < 1 ||
      raw.children.length > 5
    )
      bad('children', '主子表必须有 1 到 5 个子表');
    else {
      const tables = new Set([raw.tableName]);
      const businesses = new Set([raw.businessName]);
      raw.children.forEach((ch: unknown, i) => {
        const p = `children[${i}]`;
        if (!keys(ch, ['tableName', 'foreignKey', 'title', 'fields'], p))
          return;
        const business =
          typeof ch.tableName === 'string'
            ? ch.tableName.replace(
                new RegExp(
                  `^${String(raw.moduleName).replace(/[^a-z0-9_]/g, '')}_`,
                ),
                '',
              )
            : '';
        if (
          typeof ch.tableName !== 'string' ||
          !identifier.test(ch.tableName) ||
          ch.tableName.startsWith('sys_') ||
          tables.has(ch.tableName) ||
          businesses.has(business)
        )
          bad(`${p}.tableName`, '子表名无效、保留或生成文件名重复');
        else {
          tables.add(ch.tableName);
          businesses.add(business);
        }
        if (
          typeof ch.foreignKey !== 'string' ||
          !property.test(ch.foreignKey) ||
          forbidden.has(ch.foreignKey) ||
          baseColumns.has(
            ch.foreignKey.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
          )
        )
          bad(`${p}.foreignKey`, '外键属性名无效');
        text(ch.title, `${p}.title`, 30);
        fields(
          ch.fields,
          `${p}.fields`,
          typeof ch.foreignKey === 'string' ? ch.foreignKey : undefined,
        );
      });
    }
  } else if (raw.children !== undefined)
    bad('children', '仅主子表允许子表配置');
  return errors;
}

export function specToConfig(s: ModuleSpec): CodegenConfig {
  const fields = (fs: SpecField[]): CodegenField[] =>
    fs.map((f) => ({
      name: f.property,
      column: f.column,
      label: f.label,
      type: f.type,
      length: f.length,
      precision: f.precision,
      scale: f.scale,
      comment: f.comment,
      ...(Object.hasOwn(f, 'defaultValue')
        ? { defaultValue: f.defaultValue }
        : {}),
      nullable: f.nullable ?? false,
      required: !f.nullable && !Object.hasOwn(f, 'defaultValue'),
      unique: f.unique,
      dict: f.dictCode,
      fieldPerm: f.fieldPerm,
      list: f.type !== 'json' && f.type !== 'text',
      form: true,
      query: ['string', 'text'].includes(f.type) ? 'like' : 'eq',
      component: FIELD_CATALOG.find((t) => t.type === f.type)!.component,
    }));
  const result: CodegenConfig = {
    module: s.moduleName,
    business: s.businessName,
    label: s.title,
    permPrefix: s.permissionPrefix,
    table: s.tableName,
    template: s.template === 'masterDetail' ? 'master-detail' : s.template,
    fields: fields(s.fields),
    tree: s.tree,
    children: s.children?.map((ch) => ({
      table: ch.tableName,
      foreignKey: ch.foreignKey,
      label: ch.title,
      fields: fields(ch.fields),
    })),
    options: {
      deleteMode: s.options?.deleteMode ?? 'soft',
      dataScope: s.options?.scopeEnabled ?? false,
      export: s.options?.exportEnabled ?? true,
      formMode: 'drawer',
    },
  };
  // 旧渲染器仍接收同一配置；树形父级沿用原有 bigint 分支。
  if (result.tree) {
    const parent = result.fields.find(
      (f) => f.name === result.tree!.parentField,
    );
    if (parent) parent.type = 'int';
  }
  return result;
}

/** 旧配置仅提取数据结构，不把显示选项带入新规格。纯函数也供数据迁移使用。 */
export function migrateLegacyConfig(c: CodegenConfig): ModuleSpec {
  const fields = (fs: CodegenField[]): SpecField[] =>
    fs.map((f) => ({
      property: f.name,
      column: f.column,
      label: f.label,
      type: f.type === 'dictionary' && !f.dict ? 'string' : f.type,
      ...(f.length !== undefined ? { length: f.length } : {}),
      ...(f.precision !== undefined ? { precision: f.precision } : {}),
      ...(f.scale !== undefined ? { scale: f.scale } : {}),
      nullable: f.nullable ?? false,
      unique: f.unique ?? false,
      ...(f.comment !== undefined ? { comment: f.comment } : {}),
      ...(Object.hasOwn(f, 'defaultValue')
        ? { defaultValue: f.defaultValue }
        : {}),
      ...(f.dict ? { dictCode: f.dict } : {}),
      ...(f.fieldPerm
        ? {
            fieldPerm: {
              default: (f.fieldPerm.default ??
                'editable') as SpecFieldPerm['default'],
              ...(f.fieldPerm.mask
                ? { mask: f.fieldPerm.mask as SpecFieldPerm['mask'] }
                : {}),
            },
          }
        : {}),
    }));
  return {
    version: 1,
    moduleName: c.module,
    businessName: c.business,
    title: c.label,
    permissionPrefix: c.permPrefix,
    tableName: c.table,
    template: c.template === 'master-detail' ? 'masterDetail' : c.template,
    fields: fields(c.fields),
    ...(c.template === 'tree' && c.tree ? { tree: c.tree } : {}),
    ...(c.template === 'master-detail'
      ? {
          children: (c.children ?? []).map((ch) => ({
            tableName: ch.table,
            foreignKey: ch.foreignKey,
            title: ch.label,
            fields: fields(
              ch.fields.filter(
                (field) =>
                  field.name !== ch.foreignKey &&
                  field.column !==
                    ch.foreignKey.replace(
                      /[A-Z]/g,
                      (char) => `_${char.toLowerCase()}`,
                    ),
              ),
            ),
          })),
        }
      : {}),
    options: {
      deleteMode: c.options?.deleteMode ?? 'soft',
      scopeEnabled: c.options?.dataScope ?? false,
      exportEnabled: c.options?.export ?? true,
    },
  };
}
export function readSpec(raw: unknown): ModuleSpec {
  if (object(raw) && raw.version === 1) return raw as unknown as ModuleSpec;
  const errors = validateCodegenConfig(raw);
  if (errors.length) throw new Error('旧生成配置不合法，无法转换规格');
  return migrateLegacyConfig(raw as CodegenConfig);
}
