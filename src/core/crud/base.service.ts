import { randomUUID } from 'node:crypto';
import { Brackets, type DataSource, type EntityManager } from 'typeorm';
import {
  INTERNAL_FIELDS,
  SYSTEM_FIELDS,
  type BaseEntity,
} from './base.entity.js';
import { ScopedSelectQueryBuilder } from '../tenant/scoped-query-builder.js';
import { crudErrors, translateDbError } from './crud.errors.js';
import type { CrudAudit } from './crud-audit.js';
import {
  childRowsOf,
  deleteChildrenOf,
  loadChildren,
  planChildren,
  purgeChildrenOf,
  restoreChildrenOf,
  saveChildren,
} from './crud-children.js';
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
  /** 查实体是不是某个主表的子表（由注册表提供） */
  childOwner: (entity: Function) => string | undefined;
  /** 硬删除前留底 */
  audit: CrudAudit;
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
    // 一个 Service 实例只服务一个资源：同一实体的两个资源共用一个实例，会让先初始化的资源
    // 悄悄用上后一个资源的可写字段、删除方式和页面描述
    if (this.binding && this.binding.meta !== binding.meta)
      throw new Error(
        `${this.constructor.name} 已绑定到资源 ${this.binding.meta.prefix}，不能再绑定 ${binding.meta.prefix}：每个资源要用自己的 Service 类`,
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
  /** 从回收站恢复前：rows 是要恢复的数据（仍是已删除状态） */
  protected async beforeRestore(_rows: T[], _tx: CrudTx): Promise<void> {}
  protected async afterRestore(_rows: T[], _tx: CrudTx): Promise<void> {}
  /** 彻底删除前：例如检查有没有被引用；抛异常整批不删 */
  protected async beforePurge(_rows: T[], _tx: CrudTx): Promise<void> {}

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
    const manager = this.crud.dataSource.manager;
    const row = await this.findOne(manager, id, 'info');
    if (!row) throw crudErrors.notFound();
    return this.toDetail(manager, row, this.crud.context.current().tenantId);
  }

  // ---------- 写 ----------

  /** 新增；有子表时 children 里每个子表只有 added，主表和子表在同一个事务里写入 */
  async add(data: Partial<T>, children?: unknown): Promise<CrudRow<T>> {
    this.assertNotChild();
    const plans = await planChildren(
      this.meta as CrudResourceMeta,
      children,
      'add',
      this.crud.dataSource,
    );
    return this.transaction(async (tx) => {
      const values = this.pick(data, this.meta.addable);
      this.assertNullable(values);
      await this.beforeAdd(values, tx);
      const id = await this.insertRow(tx, values);
      // 没提交的子表也要按「空」检查行数下限
      const all = this.meta.children.map(
        (child) =>
          plans.find((p) => p.child === child) ?? {
            child,
            added: [],
            updated: [],
            deleted: [],
          },
      );
      if (all.length)
        await saveChildren(tx, tx.meta, id, all, this.crud.audit, true);
      const row = await this.findOne(tx.manager, id, 'add');
      if (!row) throw new Error(`新增后读不到数据：${this.meta.prefix} ${id}`);
      await this.afterAdd(row, tx);
      return this.toDetail(tx.manager, row, tx.ctx.tenantId);
    });
  }

  /**
   * 修改；有子表时 children 里每个子表分 added / updated / deleted 三组，没提交的行保持不动。
   * 只改子表也会让主表版本号加 1（子表只有主表这一个写入口）。
   */
  async update(
    id: string,
    version: number,
    data: Partial<T>,
    children?: unknown,
  ): Promise<CrudRow<T>> {
    this.assertNotChild();
    const plans = await planChildren(
      this.meta as CrudResourceMeta,
      children,
      'update',
      this.crud.dataSource,
    );
    return this.transaction(async (tx) => {
      // 锁住主表这一行：同一张单据的聚合保存排队执行，子表的行数、唯一检查基于一致的数据
      const existing = await this.findOne(tx.manager, id, 'update', true);
      if (!existing) throw crudErrors.notFound();
      if (existing.version !== version) throw crudErrors.versionConflict();
      const changes = this.pick(data, this.meta.updatable);
      this.assertNullable(changes);
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
      if (plans.length)
        await saveChildren(tx, tx.meta, id, plans, this.crud.audit);

      const row = await this.findOne(tx.manager, id, 'update');
      if (!row) throw crudErrors.notFound();
      await this.afterUpdate(row, tx);
      return this.toDetail(tx.manager, row, tx.ctx.tenantId);
    });
  }

  async delete(ids: string[]): Promise<{ count: number }> {
    this.assertNotChild();
    const unique = [...new Set(ids)];
    return this.transaction(async (tx) => {
      const rows = await this.select(tx.manager, 'delete')
        .andWhere(`${ALIAS}.id IN (:...__ids)`, { __ids: unique })
        .setLock('pessimistic_write')
        .getMany();
      if (rows.length !== unique.length) throw crudErrors.notFound();
      await this.beforeDelete(rows, tx);

      if (this.meta.deleteMode === 'hard') {
        // 真删之前把整行内容（含子行）留底
        await this.crud.audit.hardDeleted(
          {
            resource: this.meta.prefix,
            reason: 'delete',
            ctx: tx.ctx,
            rows,
            children: await childRowsOf(tx, tx.meta, unique, false),
          },
          tx.manager,
        );
      }
      // 这一次删除的主表和子行同一个批次，恢复主表时只恢复这一批子行
      const batch = randomUUID();
      if (this.meta.children.length)
        await deleteChildrenOf(tx, tx.meta, unique, batch);

      const base =
        this.meta.deleteMode === 'soft'
          ? tx.manager
              .createQueryBuilder()
              .update(this.meta.entity)
              .set({
                deletedAt: () => 'CURRENT_TIMESTAMP(3)',
                deleteBatch: batch,
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

  // ---------- 回收站（只有软删除的资源有） ----------

  /** 回收站列表：只列已删除的数据，按删除时间倒序；搜索框和正常列表用同样的字段 */
  async recyclePage(query: {
    page?: number;
    size?: number;
    keyword?: string;
  }): Promise<PageResult<CrudRow<T> & { deletedAt: Date }>> {
    this.assertSoft();
    const meta = this.meta;
    const page = query.page ?? 1;
    const size = query.size ?? 20;
    const qb = this.deletedSelect(this.crud.dataSource.manager, 'recycle');
    const keyword = query.keyword?.trim();
    if (keyword && meta.keyWords.length)
      qb.andWhere(
        new Brackets((b) => {
          for (const f of meta.keyWords)
            b.orWhere(`${ALIAS}.\`${this.column(f)}\` LIKE :__kw`);
        }),
        { __kw: `%${escapeLike(keyword)}%` },
      );
    const [rows, total] = await qb
      .orderBy(`${ALIAS}.deletedAt`, 'DESC')
      .addOrderBy(`${ALIAS}.id`, 'DESC')
      .offset((page - 1) * size)
      .limit(size)
      .getManyAndCount();
    return {
      list: rows.map((r) => ({
        ...this.toRow(r),
        deletedAt: r.deletedAt as Date,
      })),
      total,
      page,
      size,
    };
  }

  /**
   * 从回收站恢复，整批成败。每行带上用户在回收站里看到的版本号：
   * - 有一条不在回收站（没删、不存在、无权访问）整批 404；
   * - 版本号对不上（这期间被恢复、改过又删了，或者被别人处理过）整批 409，避免按过期的确认操作新的删除批次；
   * - 业务键已被新数据占用时数据库唯一约束（含 activeGuard）报冲突，整批回滚并提示，不会静默覆盖或改名。
   * 子表只恢复和主表同一删除批次的行。
   */
  async restore(
    items: { id: string; version: number }[],
  ): Promise<{ count: number }> {
    this.assertNotChild();
    this.assertSoft();
    return this.transaction(async (tx) => {
      const rows = await this.lockRecycled(tx, items, 'restore');
      await this.beforeRestore(rows, tx);
      const qb = tx.manager
        .createQueryBuilder()
        .update(this.meta.entity)
        .set({
          deletedAt: null,
          deleteBatch: null,
          updatedBy: tx.ctx.userId,
          updatedAt: () => 'CURRENT_TIMESTAMP(3)',
        } as never)
        .andWhere('`deleted_at` IS NOT NULL');
      this.whereIdVersion(qb, items);
      for (const c of this.scope(tx, 'restore')) qb.andWhere(c.sql, c.params);
      const result = await qb.execute();
      if (result.affected !== items.length) throw crudErrors.versionConflict();
      if (this.meta.children.length)
        await restoreChildrenOf(
          tx,
          tx.meta,
          rows.map((r) => ({ id: String(r.id), batch: r.deleteBatch })),
        );
      await this.afterRestore(rows, tx);
      return { count: items.length };
    });
  }

  /** 彻底删除回收站里的数据，整批成败，版本号规则同恢复；真删前把整行内容（含全部子行）留底 */
  async purge(
    items: { id: string; version: number }[],
  ): Promise<{ count: number }> {
    this.assertNotChild();
    this.assertSoft();
    return this.transaction(async (tx) => {
      const rows = await this.lockRecycled(tx, items, 'purge');
      const ids = rows.map((r) => String(r.id));
      await this.beforePurge(rows, tx);
      await this.crud.audit.hardDeleted(
        {
          resource: this.meta.prefix,
          reason: 'purge',
          ctx: tx.ctx,
          rows,
          children: await childRowsOf(tx, tx.meta, ids, true),
        },
        tx.manager,
      );
      if (this.meta.children.length) await purgeChildrenOf(tx, tx.meta, ids);
      const qb = tx.manager
        .createQueryBuilder()
        .delete()
        .from(this.meta.entity)
        .andWhere('`deleted_at` IS NOT NULL');
      this.whereIdVersion(qb, items);
      for (const c of this.scope(tx, 'purge')) qb.andWhere(c.sql, c.params);
      const result = await qb.execute();
      if (result.affected !== items.length) throw crudErrors.versionConflict();
      return { count: items.length };
    });
  }

  /** 锁住回收站里的这些行：缺任何一行整批 404，有版本号对不上整批 409 */
  private async lockRecycled(
    tx: CrudTx,
    items: { id: string; version: number }[],
    action: CrudAction,
  ): Promise<T[]> {
    const ids = items.map((i) => i.id);
    if (new Set(ids).size !== ids.length)
      throw crudErrors.badRequest('同一行出现了多次', [
        { field: 'items', messages: ['同一行出现了多次'] },
      ]);
    const rows = await this.deletedSelect(tx.manager, action)
      .andWhere(`${ALIAS}.id IN (:...__ids)`, { __ids: ids })
      .setLock('pessimistic_write')
      .getMany();
    if (rows.length !== ids.length) throw crudErrors.notFound();
    const current = new Map(rows.map((r) => [String(r.id), r.version]));
    if (items.some((i) => current.get(i.id) !== i.version))
      throw crudErrors.versionConflict();
    return rows;
  }

  /** 「编号 + 版本号」逐行条件：(id, version) IN ((?, ?), ...) */
  private whereIdVersion(
    qb: { andWhere: (sql: string, params?: object) => unknown },
    items: { id: string; version: number }[],
  ): void {
    const params: Record<string, unknown> = {};
    const tuples = items.map((it, n) => {
      params[`__i${n}`] = it.id;
      params[`__v${n}`] = it.version;
      return `(:__i${n}, :__v${n})`;
    });
    qb.andWhere(`(\`id\`, \`version\`) IN (${tuples.join(', ')})`, params);
  }

  // ---------- 给子类和后续任务用的工具 ----------

  /**
   * 子表只有主表这一个写入口：实体是别的资源的子表时，它自己的 Service 不能新增、修改、删除，
   * 后台任务或其他业务代码直接调用也一样。主表聚合保存走的是 crud-children 里的内部写入，不经过这里。
   */
  private assertNotChild(): void {
    const owner = this.crud.childOwner(this.meta.entity);
    if (owner)
      throw new Error(
        `${this.meta.prefix} 的实体是 ${owner} 的子表，只能通过 ${owner} 的新增、修改一起保存`,
      );
  }

  private assertSoft(): void {
    if (this.meta.deleteMode !== 'soft')
      throw new Error(`${this.meta.prefix} 是硬删除资源，没有回收站`);
  }

  /** 只查已删除的数据（回收站用），同样带范围条件；删除批次一起取出来 */
  private deletedSelect(manager: EntityManager, action: CrudAction) {
    return this.select(manager, action)
      .withDeleted()
      .addSelect(`${ALIAS}.deleteBatch`)
      .andWhere(`${ALIAS}.\`deleted_at\` IS NOT NULL`);
  }

  /**
   * 第 4 级定制用：在事务里插入一行，由框架填租户、创建人、修改人，剔除系统字段，返回新编号。
   * 业务代码不给 tenantId 赋值，也不能借 values 改它。
   */
  protected async insertRow(tx: CrudTx, values: Partial<T>): Promise<string> {
    const result = await tx.manager
      .createQueryBuilder()
      .insert()
      .into(this.meta.entity)
      .values({
        ...this.stripSystem(values),
        tenantId: tx.ctx.tenantId,
        createdBy: tx.ctx.userId,
        updatedBy: tx.ctx.userId,
      } as never)
      .execute();
    return String(result.identifiers[0]?.id);
  }

  /** 开一个事务；里面的读写都要用 tx.manager。跨租户查询模式（@IgnoreTenant）只能读，不能开写事务 */
  protected async transaction<R>(fn: (tx: CrudTx) => Promise<R>): Promise<R> {
    const { dataSource, context, meta } = this.crud;
    const ctx = context.current();
    if (ctx.ignoreTenant)
      throw new Error(
        '跨租户查询模式（@IgnoreTenant）只能读，不能新增、修改、删除',
      );
    try {
      return await dataSource.transaction((manager) =>
        fn({ manager, ctx, meta: meta as CrudResourceMeta }),
      );
    } catch (err) {
      throw translateDbError(err, meta as CrudResourceMeta, dataSource);
    }
  }

  /**
   * 带范围条件的查询，别名固定为 e；第 4 级自定义接口查数据也要用它，不能直接用 Repository。
   * 范围条件（租户、以后的数据范围）由框架放在 WHERE 最后整体 AND，调用方用 where / orWhere 也去不掉。
   */
  protected select(
    manager: EntityManager,
    action: CrudAction,
  ): ScopedSelectQueryBuilder<T> {
    const qb = manager.createQueryBuilder(this.meta.entity, ALIAS);
    const ctx = this.crud.context.current();
    const conds = this.crud.scope.conditions(
      ctx,
      this.meta as CrudResourceMeta,
      action,
      ALIAS,
    );
    return new ScopedSelectQueryBuilder(qb, {
      conditions: conds.map((c) => c.sql),
      params: Object.assign({}, ...conds.map((c) => c.params)) as Record<
        string,
        unknown
      >,
    });
  }

  private scope(tx: CrudTx, action: CrudAction) {
    return this.crud.scope.conditions(tx.ctx, tx.meta, action);
  }

  private findOne(
    manager: EntityManager,
    id: string,
    action: CrudAction,
    lock = false,
  ) {
    const qb = this.select(manager, action).andWhere(`${ALIAS}.id = :__id`, {
      __id: id,
    });
    if (lock) qb.setLock('pessimistic_write');
    return qb.getOne();
  }

  /** 详情：主表可读字段，有子表时加上 children */
  private async toDetail(
    manager: EntityManager,
    row: T,
    tenantId: string,
  ): Promise<CrudRow<T>> {
    const out = this.toRow(row) as Record<string, unknown>;
    if (this.meta.children.length)
      out.children = await loadChildren(
        manager,
        this.meta as CrudResourceMeta,
        tenantId,
        String(row.id),
      );
    return out as CrudRow<T>;
  }

  private column(property: string): string {
    const c = this.crud.dataSource
      .getMetadata(this.meta.entity)
      .findColumnWithPropertyName(property);
    if (!c) throw new Error(`${this.meta.prefix} 没有字段 ${property}`);
    return c.databaseName;
  }

  /**
   * 「不传」和「清空」要分开：不传的字段保持原值；显式传 null 表示清空，只有数据库里允许为空的列才行。
   * 生成的修改 DTO 每个字段都是可选的，校验会放过 null，所以在这里按列定义再核对一次，返回字段错误而不是等数据库报 500。
   */
  private assertNullable(values: Partial<T>): void {
    const em = this.crud.dataSource.getMetadata(this.meta.entity);
    const errors = Object.entries(values)
      .filter(
        ([k, v]) => v === null && !em.findColumnWithPropertyName(k)?.isNullable,
      )
      .map(([k]) => {
        const label =
          this.meta.fields.find((f) => f.property === k)?.label ?? k;
        return { field: `data.${k}`, messages: [`${label}不能为空`] };
      });
    if (errors.length) throw crudErrors.badRequest('请求参数有误', errors);
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

  /**
   * 响应只输出资源定义里的可读字段（基础字段 + @CrudField 声明的字段）。
   * 实体上没声明的列（内部字段）一律不出去；T16 的逐行字段权限在这之上再裁剪。
   */
  protected toRow(row: T): CrudRow<T> {
    const src = row as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of this.meta.readable) if (k in src) out[k] = src[k];
    return out as CrudRow<T>;
  }
}
