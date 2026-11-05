import type { Type } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { BaseEntity } from './base.entity.js';
import type { CrudFieldMeta } from './crud-field.decorator.js';

/** 按配置开放的接口。导出在 T18，回收站在 T03 验收点③ */
export type CrudApi = 'page' | 'info' | 'add' | 'update' | 'delete';
export const CRUD_APIS: readonly CrudApi[] = [
  'page',
  'info',
  'add',
  'update',
  'delete',
];

/** 数据范围、字段权限等按「动作」区分 */
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
}

/** 一个资源在启动时整理好的完整定义，页面描述、字段权限、MCP 都从这里读 */
export interface CrudResourceMeta<T extends BaseEntity = BaseEntity> {
  prefix: string;
  label: string;
  /** 接口文档和生成代码用的名字，如 system/user → SystemUser */
  name: string;
  /** 权限码前缀，如 system:user */
  permPrefix: string;
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
}

/** 请求上下文：租户和当前用户。T04 / T05 接入后由认证守卫写入 */
export interface CrudContext {
  tenantId: string;
  userId: string | null;
}

/** 钩子拿到的事务环境：只能用这里的 manager 读写，保证在同一个事务里 */
export interface CrudTx {
  manager: EntityManager;
  ctx: CrudContext;
  meta: CrudResourceMeta;
}

export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  size: number;
}
