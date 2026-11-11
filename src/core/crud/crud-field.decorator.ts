import { ApiProperty } from '@nestjs/swagger';

/** tree-select：树形资源的父级字段，选项来自本资源的 tree 接口 */
export type FormComponent =
  | 'input'
  | 'textarea'
  | 'number'
  | 'select'
  | 'switch'
  | 'date'
  | 'datetime'
  | 'tree-select';

export interface DictItem {
  value: string | number | boolean;
  label: string;
}

export interface CrudFieldOptions {
  /** 显示名称（中文），列表表头、表单标签、错误提示都用它 */
  label: string;
  /** 列表列；false 表示不在列表里显示 */
  list?: false | { width?: number; sortable?: boolean };
  /** 表单项；false 表示不在表单里出现 */
  form?:
    | false
    | { component?: FormComponent; required?: boolean; placeholder?: string };
  /** 新增、修改时能不能写：both（默认）、add（只在新增时写）、none（只读） */
  edit?: 'both' | 'add' | 'none';
  /** 固定字典（如状态）；数据库字典在 T08 接入 */
  dict?: DictItem[];
  /** 动态字典编码；与静态dict互斥。 */
  dictCode?: string;
  /** 可以为空（只影响接口文档） */
  nullable?: boolean;
  /**
   * 编号字段要显示成用户名或组织名：后端在行的 _display 里给名称，列表、详情、导出都用它
   * （创建人、修改人、所属组织框架已自动处理，不用写）
   */
  display?: DisplayKind;
}
/** 编号字段的显示名来源 */
export type DisplayKind = 'users' | 'orgs';

export interface CrudFieldMeta extends CrudFieldOptions {
  property: string;
}

const CRUD_FIELDS = Symbol('crud:fields');

/**
 * 声明一个业务字段：页面描述、接口文档、新增和修改的可写字段都从这里来（资源定义是唯一来源）。
 * 可写的字段还必须写 class-validator 校验装饰器，否则启动时报错。
 *
 * @example
 *   @CrudField({ label: '账号', list: { sortable: true }, edit: 'add' })
 *   @IsString() @Length(2, 32)
 *   @Column({ type: 'varchar', length: 32 })
 *   username: string;
 */
export function CrudField(options: CrudFieldOptions): PropertyDecorator {
  if (
    options.dictCode !== undefined &&
    (options.dict || !/^[a-z][a-z0-9_.-]{1,63}$/.test(options.dictCode))
  )
    throw new Error('dictCode编码无效或与静态dict冲突');
  return (target, propertyKey) => {
    const property = String(propertyKey);
    const ctor = target.constructor;
    const own: CrudFieldMeta[] =
      Reflect.getOwnMetadata(CRUD_FIELDS, ctor) ?? [];
    Reflect.defineMetadata(
      CRUD_FIELDS,
      [...own.filter((f) => f.property !== property), { ...options, property }],
      ctor,
    );
    ApiProperty({
      description: options.label,
      required: options.form ? Boolean(options.form.required) : false,
      nullable: options.nullable,
      ...(options.dict ? { enum: options.dict.map((d) => d.value) } : {}),
    })(target, propertyKey);
  };
}

/** 读取实体上声明的业务字段（含父类声明的，子类同名覆盖父类） */
export function getCrudFields(entity: Function): CrudFieldMeta[] {
  const chain: Function[] = [];
  for (
    let c: Function | null = entity;
    c && c !== Function.prototype;
    c = Object.getPrototypeOf(c) as Function | null
  )
    chain.unshift(c);
  const byName = new Map<string, CrudFieldMeta>();
  for (const c of chain)
    for (const f of (Reflect.getOwnMetadata(CRUD_FIELDS, c) ??
      []) as CrudFieldMeta[])
      byName.set(f.property, f);
  return [...byName.values()];
}
