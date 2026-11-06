// 通用 CRUD 对外入口：业务模块只从这里引用
export { BaseEntity, DEFAULT_TENANT_ID } from './base.entity.js';
export { BaseController } from './base.controller.js';
export { BaseService, type PageQuery, type CrudRow } from './base.service.js';
export { CrudController } from './crud-controller.decorator.js';
export {
  CrudField,
  type CrudFieldOptions,
  type DictItem,
} from './crud-field.decorator.js';
export { CrudScope, type ScopeCondition } from './crud-scope.js';
export { CrudRuntime } from './crud.runtime.js';
export { CrudAudit, type HardDeleteEvent } from './crud-audit.js';
export { crudErrors } from './crud.errors.js';
export type {
  CrudApi,
  CrudContext,
  CrudControllerOptions,
  CrudResourceMeta,
  CrudTx,
  PageResult,
} from './crud.types.js';
