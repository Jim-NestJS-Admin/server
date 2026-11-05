import {
  Brackets,
  type DataSource,
  type EntityManager,
  type SelectQueryBuilder,
} from 'typeorm';
import {
  INTERNAL_FIELDS,
  SYSTEM_FIELDS,
  type BaseEntity,
} from './base.entity.js';
import { crudErrors, translateDbError } from './crud.errors.js';
import type { CrudContextProvider, CrudScope } from './crud-scope.js';
import type {
  CrudAction,
  CrudResourceMeta,
  CrudTx,
  PageResult,
  SortItem,
} from './crud.types.js';

export interface PageQuery {
  page?: number;
  size?: number;
  keyword?: string;
  sort?: SortItem[];
  eq?: Record<string, unknown>;
}

/** 接口响应里的一行：去掉租户、删除标记这类内部字段 */
export type CrudRow<T> = Omit<T, (typeof INTERNAL_FIELDS)[number]>;

export interface CrudBinding<T extends BaseEntity> {
  dataSource: DataSource;
  scope: CrudScope;
  context: CrudContextProvider;
  meta: CrudResourceMeta<T>;
}

const ALIAS = 'e';
const SYSTEM = new Set<string>(SYSTEM_FIELDS);
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * 通用 CRUD 服务（架构「核心框架层 · 通用 CRUD」）。
 *
 * - 所有读写都自动带上 CrudScope 的条件（租户，以后加数据范围），业务代码不用写，也不能绕开；
 * - 新增、修改、删除都在一个事务里，钩子也在这个事务里执行，钩子抛异常整个操作回滚；
 * - 修改用「编号 + 旧版本号 + 范围条件」的一条条件更新，影响 0 行就是版本冲突；
 * - 批量删除整批成败：有任何一行不存在或无权访问，整批都不执行，错误和单条不存在一样。
 *
 * 定制：继承后覆盖钩子（第 2 级）或方法（第 3 级，记得调用 super）。
 * 钩子里不能直接发通知或调外部系统，要写进发件箱，事务提交后再投递。
 */
export class BaseService<T extends BaseEntity> {
  private binding?: CrudBinding<T>;

  /** 由 @CrudController 在启动时绑定资源定义和运行环境 */
  bindCrud(binding: CrudBinding<T>): void {
    if (this.binding && this.binding.meta.entity !== binding.meta.entity)
      throw new Error(
        `${this.constructor.name} 已绑定到资源 ${this.binding.meta.prefix}，不能再绑定 ${binding.meta.prefix}`,
      );
    this.binding = binding;
  }

  protected get crud(): CrudBinding<T> {
    if (!this.binding)
      throw new Error(
        `${this.constructor.name} 还没有绑定资源：它必须通过 @CrudController 的 service 选项使用`,
      );
    return this.binding;
  }

  get meta(): CrudResourceMeta<T> {
    return this.crud.meta;
  }

  // ---------- 钩子（第 2 级定制）：默认什么都不做 ----------

  /** 新增前：可以改 data（如加密密码），抛异常阻止新增 */
  protected async beforeAdd(_data: Partial<T>, _tx: CrudTx): Promise<void> {}
  protected async afterAdd(_row: T, _tx: CrudTx): Promise<void> {}
  /** 修改前：changes 只含本次要改的字段，existing 是修改前的数据 */
  protected async beforeUpdate(
    _changes: Partial<T>,
    _existing: T,
    _tx: CrudTx,
  ): Promise<void> {}
  protected async afterUpdate(_row: T, _tx: CrudTx): Promise<void> {}
  /** 删除前：rows 是本批要删的全部数据，例如检查有没有被引用 */
  protected async beforeDelete(_rows: T[], _tx: CrudTx): Promise<void> {}
  protected async afterDelete(_rows: T[], _tx: CrudTx): Promise<void> {}

  // ---------- 读 ----------

  async page(query: PageQuery): Promise<PageResult<CrudRow<T>>> {
    const meta = this.meta;
    const page = query.page ?? 1;
    const size = query.size ?? 20;
    if (size > meta.maxSize)
      throw crudErrors.badRequest(`每页最多 ${meta.maxSize} 条`, [
        { field: 'size', messages: [`每页最多 ${meta.maxSize} 条`] },
      ]);
    const qb = this.select(this.crud.dataSource.manager, 'page');

    const keyword = query.keyword?.trim();
    if (keyword && meta.keyWords.length) {
      qb.andWhere(
        new Brackets((b) => {
          for (const f of meta.keyWords)
            b.orWhere(`${ALIAS}.\`${this.column(f)}\` LIKE :__kw`);
        }),
        { __kw: `%${escapeLike(keyword)}%` },
      );
    }

    let i = 0;
    for (const [field, value] of Object.entries(query.eq ?? {})) {
      if (value === undefined) continue;
      if (!meta.fieldEq.includes(field))
        throw crudErrors.badRequest('筛选字段不允许', [
          { field: `eq.${field}`, messages: ['这个字段不能用来筛选'] },
        ]);
      const c = `${ALIAS}.\`${this.column(field)}\``;
      if (value === null) qb.andWhere(`${c} IS NULL`);
      else qb.andWhere(`${c} = :__eq${i}`, { [`__eq${i}`]: value });
      i++;
    }

    const sort = query.sort?.length ? query.sort : meta.defaultSort;
    for (const s of sort) {
      if (!meta.sortable.includes(s.field))
        throw crudErrors.badRequest('排序字段不允许', [
          { field: 'sort', messages: [`不能按 ${s.field} 排序`] },
        ]);
      qb.addOrderBy(`${ALIAS}.${s.field}`, s.order === 'asc' ? 'ASC' : 'DESC');
    }
    // 排序值相同的行按编号定序，翻页时不会重复或漏掉
    if (!sort.some((s) => s.field === 'id'))
      qb.addOrderBy(`${ALIAS}.id`, 'DESC');

    const [rows, total] = await qb
      .offset((page - 1) * size)
      .limit(size)
      .getManyAndCount();
    return { list: rows.map((r) => this.toRow(r)), total, page, size };
  }

  async info(id: string): Promise<CrudRow<T>> {
    const row = await this.findOne(this.crud.dataSource.manager, id, 'info');
    if (!row) throw crudErrors.notFound();
    return this.toRow(row);
  }

  // ---------- 写 ----------

  async add(data: Partial<T>): Promise<CrudRow<T>> {
    return this.transaction(async (tx) => {
      const values = this.pick(data, this.meta.addable);
      await this.beforeAdd(values, tx);
      const clean = this.stripSystem(values);
      const result = await tx.manager
        .createQueryBuilder()
        .insert()
        .into(this.meta.entity)
        .values({
          ...clean,
          tenantId: tx.ctx.tenantId,
          createdBy: tx.ctx.userId,
          updatedBy: tx.ctx.userId,
        } as never)
        .execute();
      const id = String(result.identifiers[0]?.id);
      const row = await this.findOne(tx.manager, id, 'add');
      if (!row) throw new Error(`新增后读不到数据：${this.meta.prefix} ${id}`);
      await this.afterAdd(row, tx);
      return this.toRow(row);
    });
  }

  async update(
    id: string,
    version: number,
    data: Partial<T>,
  ): Promise<CrudRow<T>> {
    return this.transaction(async (tx) => {
      const existing = await this.findOne(tx.manager, id, 'update');
      if (!existing) throw crudErrors.notFound();
      if (existing.version !== version) throw crudErrors.versionConflict();
      const changes = this.pick(data, this.meta.updatable);
      await this.beforeUpdate(changes, existing, tx);
      const clean = this.stripSystem(changes);

      const qb = tx.manager
        .createQueryBuilder()
        .update(this.meta.entity)
        .set({
          ...clean,
          updatedBy: tx.ctx.userId,
          updatedAt: () => 'CURRENT_TIMESTAMP(3)',
        } as never)
        .where('`id` = :__id', { __id: id })
        .andWhere('`version` = :__version', { __version: version })
        .andWhere('`deleted_at` IS NULL');
      for (const c of this.scope(tx, 'update')) qb.andWhere(c.sql, c.params);
      const result = await qb.execute();
      // 读到时版本一致、更新时 0 行：说明这期间被别人改了或删了
      if (!result.affected) throw crudErrors.versionConflict();

      const row = await this.findOne(tx.manager, id, 'update');
      if (!row) throw crudErrors.notFound();
      await this.afterUpdate(row, tx);
      return this.toRow(row);
    });
  }

  async delete(ids: string[]): Promise<{ count: number }> {
    const unique = [...new Set(ids)];
    return this.transaction(async (tx) => {
      const rows = await this.select(tx.manager, 'delete')
        .andWhere(`${ALIAS}.id IN (:...__ids)`, { __ids: unique })
        .setLock('pessimistic_write')
        .getMany();
      if (rows.length !== unique.length) throw crudErrors.notFound();
      await this.beforeDelete(rows, tx);

      const base =
        this.meta.deleteMode === 'soft'
          ? tx.manager
              .createQueryBuilder()
              .update(this.meta.entity)
              .set({
                deletedAt: () => 'CURRENT_TIMESTAMP(3)',
                updatedBy: tx.ctx.userId,
                updatedAt: () => 'CURRENT_TIMESTAMP(3)',
              } as never)
          : tx.manager.createQueryBuilder().delete().from(this.meta.entity);
      base
        .where('`id` IN (:...__ids)', { __ids: unique })
        .andWhere('`deleted_at` IS NULL');
      for (const c of this.scope(tx, 'delete')) base.andWhere(c.sql, c.params);
      const result = await base.execute();
      if (result.affected !== unique.length) throw crudErrors.notFound();

      await this.afterDelete(rows, tx);
      return { count: unique.length };
    });
  }

  // ---------- 给子类和后续任务用的工具 ----------

  /** 开一个事务；里面的读写都要用 tx.manager */
  protected async transaction<R>(fn: (tx: CrudTx) => Promise<R>): Promise<R> {
    const { dataSource, context, meta } = this.crud;
    const ctx = context.current();
    try {
      return await dataSource.transaction((manager) =>
        fn({ manager, ctx, meta: meta as CrudResourceMeta }),
      );
    } catch (err) {
      throw translateDbError(err, meta as CrudResourceMeta, dataSource);
    }
  }

  /** 带范围条件的查询，别名固定为 e；第 4 级自定义接口查数据也要用它，不能直接用 Repository */
  protected select(
    manager: EntityManager,
    action: CrudAction,
  ): SelectQueryBuilder<T> {
    const qb = manager.createQueryBuilder(this.meta.entity, ALIAS);
    const ctx = this.crud.context.current();
    for (const c of this.crud.scope.conditions(
      ctx,
      this.meta as CrudResourceMeta,
      action,
      ALIAS,
    ))
      qb.andWhere(c.sql, c.params);
    return qb;
  }

  private scope(tx: CrudTx, action: CrudAction) {
    return this.crud.scope.conditions(tx.ctx, tx.meta, action);
  }

  private findOne(manager: EntityManager, id: string, action: CrudAction) {
    return this.select(manager, action)
      .andWhere(`${ALIAS}.id = :__id`, { __id: id })
      .getOne();
  }

  private column(property: string): string {
    const c = this.crud.dataSource
      .getMetadata(this.meta.entity)
      .findColumnWithPropertyName(property);
    if (!c) throw new Error(`${this.meta.prefix} 没有字段 ${property}`);
    return c.databaseName;
  }

  private pick(data: Partial<T>, allowed: string[]): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const k of allowed)
      if ((data as Record<string, unknown>)[k] !== undefined)
        out[k] = (data as Record<string, unknown>)[k];
    return out as Partial<T>;
  }

  /** 钩子之后再剔除一次系统字段，钩子也不能借 data 改租户、版本这类字段 */
  private stripSystem(data: Partial<T>): Partial<T> {
    return Object.fromEntries(
      Object.entries(data).filter(([k]) => !SYSTEM.has(k)),
    ) as Partial<T>;
  }

  protected toRow(row: T): CrudRow<T> {
    const out: Record<string, unknown> = { ...(row as object) };
    for (const k of INTERNAL_FIELDS) delete out[k];
    return out as CrudRow<T>;
  }
}
