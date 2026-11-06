import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DataSource,
  type EntitySubscriberInterface,
  type InsertEvent,
  type UpdateEvent,
} from 'typeorm';
import { RequestContext } from './request-context.js';

/**
 * 最后一道保险：任何带 tenantId 列的表，经 TypeORM 写入时（含查询构造器的插入、更新）检查租户。
 * - 插入时没给租户：按当前上下文填上；给了别的租户：拒绝；
 * - 更新时想改租户：拒绝；
 * - 没有上下文：拒绝（后台任务要用 RequestContext.run 指定租户）。
 * 原生 SQL 不经过这里，所以业务代码禁止写原生 SQL 改业务表。
 */
@Injectable()
export class TenantGuardSubscriber
  implements EntitySubscriberInterface, OnModuleInit
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly context: RequestContext,
  ) {}

  onModuleInit(): void {
    if (!this.dataSource.subscribers.includes(this))
      this.dataSource.subscribers.push(this);
  }

  beforeInsert(event: InsertEvent<Record<string, unknown>>): void {
    if (!event.metadata.findColumnWithPropertyName('tenantId')) return;
    const ctx = this.context.current();
    const row = event.entity;
    if (!row) return;
    const given = row.tenantId as string | number | null | undefined;
    if (given === undefined || given === null) row.tenantId = ctx.tenantId;
    else if (String(given) !== ctx.tenantId)
      throw new Error(
        `不能往别的租户写数据：${event.metadata.tableName} 的 tenantId=${String(given)}，当前租户 ${ctx.tenantId}`,
      );
  }

  beforeUpdate(event: UpdateEvent<Record<string, unknown>>): void {
    if (!event.metadata.findColumnWithPropertyName('tenantId')) return;
    this.context.current();
    const row = event.entity as Record<string, unknown> | undefined;
    if (row && Object.hasOwn(row, 'tenantId'))
      throw new Error(`不能修改 ${event.metadata.tableName} 的租户`);
  }
}
