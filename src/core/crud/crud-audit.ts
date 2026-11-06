import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { CrudContext } from './crud.types.js';

export interface HardDeleteEvent {
  /** 资源路径，如 system/user */
  resource: string;
  /** delete：硬删除资源的删除；purge：回收站彻底删除 */
  reason: 'delete' | 'purge';
  ctx: CrudContext;
  /** 删除前的整行内容（含未声明的内部列）；只删了子行时为空数组 */
  rows: object[];
  /** 只删了子行（修改主表时 children.deleted）时，子行所属的主表编号 */
  masterId?: string;
  /** 随主表一起真删的子行，按子表名分组 */
  children: Record<string, object[]>;
}

/**
 * 真正删除数据前留底（架构「删除方式 · 硬删除」：删除前把整行内容写进操作日志）。
 * 在删除的同一个事务里调用，manager 就是这个事务：T08 操作日志落库时用它写，删除回滚日志也一起回滚。
 */
export abstract class CrudAudit {
  abstract hardDeleted(
    event: HardDeleteEvent,
    manager: EntityManager,
  ): Promise<void>;
}

/**
 * 默认实现：写结构化日志（敏感字段由日志清洗规则隐去）。T08 操作日志模块接入后替换成落库实现。
 * 日志在事务提交前写出，删除如果随后回滚，这条日志只表示「准备删除」。
 */
/**
 * 落库实现的注册口（T08）：全局模块 `{ provide: CRUD_AUDIT_WRITER, useClass: SystemCrudAudit }` 并导出，
 * 默认实现就把留底委派给它（同一事务）；没有注册时照旧只写日志。
 */
export const CRUD_AUDIT_WRITER = 'jna:crud-audit-writer';

@Injectable()
export class LoggerCrudAudit extends CrudAudit {
  private readonly logger = new Logger('CrudAudit');

  constructor(
    @Optional()
    @Inject(CRUD_AUDIT_WRITER)
    private readonly writer?: CrudAudit,
  ) {
    super();
  }

  async hardDeleted(
    event: HardDeleteEvent,
    manager: EntityManager,
  ): Promise<void> {
    if (this.writer) return this.writer.hardDeleted(event, manager);
    this.logger.log({
      event: 'crud.hard-delete',
      resource: event.resource,
      reason: event.reason,
      tenantId: event.ctx.tenantId,
      userId: event.ctx.userId,
      masterId: event.masterId,
      count: event.rows.length,
      rows: event.rows,
      children: event.children,
    });
  }
}
