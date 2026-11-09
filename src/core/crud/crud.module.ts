import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  IdempotencyEntity,
  IdempotencyLedger,
} from '../security/idempotency.ledger.js';
import { IdempotencyRunner } from '../security/idempotency.interceptor.js';
import { AuthzContext } from '../permission/authz-context.js';
import { DataScopeCrudScope } from '../permission/data-scope.scope.js';
import { CrudContextProvider, CrudScope } from './crud-scope.js';
import { CrudAudit, LoggerCrudAudit } from './crud-audit.js';
import { CrudRuntime } from './crud.runtime.js';

/**
 * 通用 CRUD 的运行环境。范围条件是租户 + 数据范围（T06，DataScopeCrudScope），
 * 数据范围来自权限守卫写进本次请求的授权结果（AuthzContext）。硬删除留底 CrudAudit 由 T08 换成落库实现。
 */
@Global()
@Module({
  // 幂等记录和业务写在同一个事务里（T25），所以账本放在 CRUD 运行环境旁边
  imports: [TypeOrmModule.forFeature([IdempotencyEntity])],
  providers: [
    IdempotencyLedger,
    IdempotencyRunner,
    CrudContextProvider,
    AuthzContext,
    { provide: CrudScope, useClass: DataScopeCrudScope },
    { provide: CrudAudit, useClass: LoggerCrudAudit },
    CrudRuntime,
  ],
  exports: [
    CrudRuntime,
    IdempotencyLedger,
    IdempotencyRunner,
    CrudScope,
    CrudContextProvider,
    CrudAudit,
    AuthzContext,
  ],
})
export class CrudModule {}
