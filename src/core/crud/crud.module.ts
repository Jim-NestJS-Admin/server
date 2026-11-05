import { Global, Module } from '@nestjs/common';
import {
  CrudContextProvider,
  CrudScope,
  TenantOnlyScope,
} from './crud-scope.js';
import { CrudRuntime } from './crud.runtime.js';

/**
 * 通用 CRUD 的运行环境。CrudScope 现在只按租户过滤；T06 换成带数据范围的实现时，
 * 在这里替换 provider 即可，资源和业务代码不用改。
 */
@Global()
@Module({
  providers: [
    CrudContextProvider,
    { provide: CrudScope, useClass: TenantOnlyScope },
    CrudRuntime,
  ],
  exports: [CrudRuntime, CrudScope, CrudContextProvider],
})
export class CrudModule {}
