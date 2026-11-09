import { Injectable, type Type } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { SYSTEM_FIELDS, type BaseEntity } from '../crud/base.entity.js';
import { RequestContext } from './request-context.js';
import { ScopedSelectQueryBuilder } from './scoped-query-builder.js';

const SYSTEM = new Set<string>(SYSTEM_FIELDS);

/**
 * 租户感知的 Repository（架构「多租户设计 · 自动过滤」）：给不走通用 CRUD 的实体用（如会话、日志、文件元数据的内部读写）。
 * 查询自动加「租户 = 当前租户」，写入自动填租户和创建人，更新、删除只动当前租户的行。
 * 业务代码不要直接用 TypeORM 的 Repository 或 manager 操作带 tenantId 的表。
 */
export class TenantRepository<T extends BaseEntity> {
  constructor(
    private readonly dataSource: DataSource,
    private readonly context: RequestContext,
    readonly entity: Type<T>,
  ) {}

  /**
   * 带租户条件的查询，别名默认 e；跨租户查询模式（@IgnoreTenant）下不加租户条件。
   * 返回的查询构造器上随便用 where / orWhere，租户条件都会整体 AND 在最后，去不掉。
   */
  query(alias = 'e', manager?: EntityManager): ScopedSelectQueryBuilder<T> {
    const qb = (manager ?? this.dataSource.manager).createQueryBuilder(
      this.entity,
      alias,
    );
    const ctx = this.context.current();
    return new ScopedSelectQueryBuilder(
      qb,
      ctx.ignoreTenant
        ? undefined
        : {
            conditions: [`${alias}.\`tenant_id\` = :__tenantId`],
            params: { __tenantId: ctx.tenantId },
          },
    );
  }

  /** 插入一行，返回编号；租户、所属组织、创建人、修改人由框架填，传进来的系统字段一律忽略 */
  async insert(values: Partial<T>, manager?: EntityManager): Promise<string> {
    const ctx = this.writable();
    const r = await (manager ?? this.dataSource.manager)
      .createQueryBuilder()
      .insert()
      .into(this.entity)
      .values({
        ...this.clean(values),
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      } as never)
      .execute();
    return String(r.identifiers[0]?.id);
  }

  /** 按编号更新当前租户、未删除的行，返回影响行数（不在本租户的行不会被改） */
  async update(
    ids: string[],
    values: Partial<T>,
    manager?: EntityManager,
  ): Promise<number> {
    if (!ids.length) return 0;
    const ctx = this.writable();
    const r = await (manager ?? this.dataSource.manager)
      .createQueryBuilder()
      .update(this.entity)
      .set({ ...this.clean(values), updatedBy: ctx.userId } as never)
      .where('`id` IN (:...__ids)', { __ids: ids })
      .andWhere('`tenant_id` = :__tenantId', { __tenantId: ctx.tenantId })
      .andWhere('`deleted_at` IS NULL')
      .execute();
    return r.affected ?? 0;
  }

  /** 按编号真删当前租户的行，返回影响行数（业务数据请用通用 CRUD 的软删除） */
  async remove(ids: string[], manager?: EntityManager): Promise<number> {
    if (!ids.length) return 0;
    const ctx = this.writable();
    const r = await (manager ?? this.dataSource.manager)
      .createQueryBuilder()
      .delete()
      .from(this.entity)
      .where('`id` IN (:...__ids)', { __ids: ids })
      .andWhere('`tenant_id` = :__tenantId', { __tenantId: ctx.tenantId })
      .execute();
    return r.affected ?? 0;
  }

  private writable() {
    const ctx = this.context.current();
    if (ctx.ignoreTenant)
      throw new Error('跨租户查询模式（@IgnoreTenant）只能读，不能写');
    return ctx;
  }

  private clean(values: Partial<T>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(values).filter(([k]) => !SYSTEM.has(k)),
    );
  }
}

/** 取某个实体的租户感知 Repository：`factory.for(SessionEntity)` */
@Injectable()
export class TenantRepositoryFactory {
  constructor(
    private readonly dataSource: DataSource,
    private readonly context: RequestContext,
  ) {}

  for<T extends BaseEntity>(entity: Type<T>): TenantRepository<T> {
    return new TenantRepository(this.dataSource, this.context, entity);
  }
}
