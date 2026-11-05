import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CrudContextProvider, CrudScope } from './crud-scope.js';
import type { CrudResourceMeta } from './crud.types.js';

/**
 * CRUD 运行环境和资源注册表：所有 @CrudController 资源在启动时登记到这里。
 * 字段权限配置（T16）、MCP 通用工具、代码生成器都从注册表读资源定义，不各自再扫一遍。
 */
@Injectable()
export class CrudRuntime {
  private readonly resources = new Map<string, CrudResourceMeta>();

  constructor(
    readonly dataSource: DataSource,
    readonly scope: CrudScope,
    readonly context: CrudContextProvider,
  ) {}

  register(meta: CrudResourceMeta): void {
    const existing = this.resources.get(meta.prefix);
    if (existing && existing.entity !== meta.entity)
      throw new Error(`资源 ${meta.prefix} 重复定义`);
    this.resources.set(meta.prefix, meta);
  }

  list(): CrudResourceMeta[] {
    return [...this.resources.values()].sort((a, b) =>
      a.prefix.localeCompare(b.prefix),
    );
  }

  get(prefix: string): CrudResourceMeta | undefined {
    return this.resources.get(prefix);
  }
}
