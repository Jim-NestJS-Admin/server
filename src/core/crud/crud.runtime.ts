import type { CrudDictionarySource } from './crud-dictionary.js';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthzContext } from '../permission/authz-context.js';
import { CrudAudit } from './crud-audit.js';
import { CrudContextProvider, CrudScope } from './crud-scope.js';
import { IdempotencyLedger } from '../security/idempotency.ledger.js';
import type { CrudResourceMeta } from './crud.types.js';
import type { CrudDisplaySource } from './crud-display.js';

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
    readonly audit: CrudAudit,
    /** 本次请求的授权（数据范围、本次有效角色、字段权限配置） */
    readonly authz: AuthzContext,
    /** 幂等记录账本：写事务提交前带上幂等记录（T25） */
    readonly idempotency: IdempotencyLedger,
  ) {}

  dictionary?: CrudDictionarySource;
  codes?: import('./crud-code.js').CrudCodeSource;

  private displaySource?: CrudDisplaySource;

  /** 系统模块启动时注册：列表里的创建人、修改人、所属组织显示名称 */
  setDisplaySource(source: CrudDisplaySource): void {
    this.displaySource = source;
  }

  get display(): CrudDisplaySource | undefined {
    return this.displaySource;
  }

  register(meta: CrudResourceMeta): void {
    const existing = this.resources.get(meta.prefix);
    if (existing && existing.entity !== meta.entity)
      throw new Error(`资源 ${meta.prefix} 重复定义`);
    this.resources.set(meta.prefix, meta);
    this.checkChildOwnership();
  }

  /**
   * 子表只有主表这一个写入口：子表实体不能再被别的主表挂上，也不能自己开放新增、修改、删除接口，
   * 否则就有绕过主表版本号改明细的通道。只读的接口（分页、详情）可以有。
   */
  private checkChildOwnership(): void {
    const owners = new Map<Function, string>();
    for (const r of this.resources.values())
      for (const c of r.children) {
        const other = owners.get(c.entity);
        if (other && other !== r.prefix)
          throw new Error(
            `子表实体 ${c.entity.name} 同时挂在 ${other} 和 ${r.prefix} 下，一个子表只能属于一个主表`,
          );
        owners.set(c.entity, r.prefix);
      }
    for (const r of this.resources.values()) {
      const owner = owners.get(r.entity);
      const writes = r.api.filter(
        (a) => a === 'add' || a === 'update' || a === 'delete',
      );
      if (owner && writes.length)
        throw new Error(
          `资源 ${r.prefix} 的实体是 ${owner} 的子表，不能开放 ${writes.join('、')} 接口：子表只能通过主表一起保存`,
        );
    }
  }

  /** 这个实体是哪个资源的子表；不是子表返回 undefined。调用时现算，和注册顺序无关 */
  childOwner(entity: Function): string | undefined {
    for (const r of this.resources.values())
      if (r.children.some((c) => c.entity === entity)) return r.prefix;
    return undefined;
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
