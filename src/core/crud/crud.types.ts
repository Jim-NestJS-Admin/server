import type { Type } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { BaseEntity } from './base.entity.js';
import type { CrudFieldMeta } from './crud-field.decorator.js';

/**
 * 按配置开放的接口。recycle / restore / purge 是回收站（列表、恢复、彻底删除），只有软删除的资源能开，
 * 恢复和彻底删除各有独立的权限码（T06）。导出在 T18。
 */
export type CrudApi =
  | 'page'
  | 'info'
  | 'add'
  | 'update'
  | 'delete'
  | 'recycle'
  | 'restore'
  | 'purge'
  | 'export'
  | 'tree';
export const CRUD_APIS: readonly CrudApi[] = [
  'page',
  'info',
  'add',
  'update',
  'delete',
  'recycle',
  'restore',
  'purge',
  'export',
  'tree',
];

export type CrudAction = CrudApi;

export interface SortItem {
  field: string;
  order: 'asc' | 'desc';
}

export interface PageQueryOptions<T> {
  /** 搜索框模糊匹配的字段 */
  keyWords?: (keyof T & string)[];
  /** 可以按等于过滤的字段（左侧树、下拉筛选） */
  fieldEq?: (keyof T & string)[];
  /** 没传排序时的默认排序；不写为按编号倒序 */
  defaultSort?: { field: keyof T & string; order: 'asc' | 'desc' }[];
  /** 每页最多条数，不超过 500（架构「安全基线」分页上限） */
  maxSize?: number;
}

/**
 * 树形资源（架构「通用 CRUD · 树形资源」）：组织、菜单、栏目这类数据。
 * 开放 tree 接口返回全部可见节点（平铺，前端按 parentField 组树）；新增、修改时校验父节点存在、可见、不成环；
 * 有下级的节点不能删除；恢复时父节点必须是有效的。移动节点就是修改父节点（和排序字段）。
 */
export interface CrudTreeOptions {
  /** 指向父节点编号的字段（属性名），默认 parentId；根节点为 null */
  parentField?: string;
  /** 节点显示名称字段，如 name */
  nameField: string;
  /** 同级排序字段（从小到大）；不写按编号 */
  sortField?: string;
}

export interface CrudTreeMeta {
  parentField: string;
  nameField: string;
  sortField?: string;
}

/** 主子表里的一个子表（架构「通用 CRUD · 主子表」） */
export interface CrudChildOptions {
  /** 子表在接口里的名字，小写字母开头的驼峰，如 items */
  resource: string;
  /** 显示名称，如「订单明细」 */
  label: string;
  /** 子表实体，必须继承 BaseEntity */
  entity: Type<BaseEntity>;
  /** 子表上指向主表编号的字段（属性名），如 orderId；由框架填写，前端不能传 */
  foreignKey: string;
  /** 最少、最多行数，默认 0 和 500 */
  min?: number;
  max?: number;
  /** 同一张单据里不能重复的字段；一组里写多个字段表示组合不能重复，如 [['productCode']] */
  unique?: string[][];
  /** 子表排序字段，详情里按它从小到大返回；不写按编号 */
  sortField?: string;
}

export interface CrudControllerOptions<T extends BaseEntity> {
  /** 资源路径，如 system/user，对应接口 /admin/system/user/*，权限码前缀 system:user */
  prefix: string;
  /** 资源显示名称（中文），用于接口文档和页面描述 */
  label: string;
  entity: Type<T>;
  api: CrudApi[];
  /** 自定义 Service（继承 BaseService，写钩子或覆盖方法）；不写时框架自动提供 */
  service?: Type<unknown>;
  pageQuery?: PageQueryOptions<T>;
  /** 删除方式：soft（默认，只打删除标记）或 hard（真删） */
  delete?: 'soft' | 'hard';
  /** 子表：主表和全部子表在同一个事务里一起保存 */
  children?: CrudChildOptions[];
  /**
   * 数据权限（架构「数据权限」）：按本次有效角色的数据范围过滤（所属组织、仅本人）。
   * 读、改、删、回收站和 BaseService.select 都生效，范围外的数据和不存在一样。
   */
  dataScope?: boolean;
  /** 树形资源；开放 tree 接口时必填 */
  tree?: CrudTreeOptions;
  /**
   * 列表默认显示哪些系统字段（其余在列设置里打开），值为 true 或改用的列名。
   * 不写时只显示创建时间。例：操作日志 { createdBy: '操作人', createdAt: '操作时间' }
   */
  systemColumns?: Partial<Record<SystemColumn, true | string>>;
}

export type SystemColumn =
  | 'id'
  | 'orgId'
  | 'createdBy'
  | 'createdAt'
  | 'updatedBy'
  | 'updatedAt'
  | 'version';

/** 子表整理好的定义 */
export interface CrudChildMeta {
  resource: string;
  label: string;
  /** 接口文档名，如 DemoOrderItems */
  name: string;
  entity: Type<BaseEntity>;
  foreignKey: string;
  fields: CrudFieldMeta[];
  addable: string[];
  updatable: string[];
  readable: string[];
  min: number;
  max: number;
  unique: string[][];
  sortField?: string;
  /** 逐行校验用的 DTO，由 buildCrudDtos 填入 */
  rowDtos?: { AddRow: Type; UpdateRow: Type };
}

/** 一个资源在启动时整理好的完整定义，页面描述、字段权限、MCP 都从这里读 */
export interface CrudResourceMeta<T extends BaseEntity = BaseEntity> {
  prefix: string;
  label: string;
  /** 接口文档和生成代码用的名字，如 system/user → SystemUser */
  name: string;
  /** 权限码前缀，如 system:user */
  permPrefix: string;
  /** 按数据范围过滤 */
  dataScope: boolean;
  entity: Type<T>;
  api: CrudApi[];
  deleteMode: 'soft' | 'hard';
  fields: CrudFieldMeta[];
  addable: string[];
  updatable: string[];
  readable: string[];
  sortable: string[];
  keyWords: string[];
  fieldEq: string[];
  defaultSort: SortItem[];
  maxSize: number;
  children: CrudChildMeta[];
  /** 树形资源配置；不是树时为 null */
  tree: CrudTreeMeta | null;
  /** 列表默认显示的系统字段（值为 true 或列名） */
  systemColumns: Record<string, true | string>;
}

/** 请求上下文：租户、当前用户、当前组织，由端的认证守卫写入（见 core/tenant/request-context） */
export interface CrudContext {
  tenantId: string;
  userId: string | null;
  orgId: string | null;
  /** 平台管理员跨租户查询（@IgnoreTenant）：不加租户条件，只能读 */
  ignoreTenant: boolean;
  /** 请求来自哪个端；后台任务、脚本是 system */
  endpoint: 'admin' | 'app' | 'web' | 'open' | 'system';
}

/** 钩子拿到的事务环境：只能用这里的 manager 读写，保证在同一个事务里 */
export interface CrudTx {
  manager: EntityManager;
  dictionary?: import('./crud-dictionary.js').CrudDictionarySource;
  ctx: CrudContext;
  meta: CrudResourceMeta;
}

export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  size: number;
}
