import { fillCodeFields } from './crud-code.js';
import { participantField } from '../permission/document-access.js';
import { exportValue } from './export-value.js';
import {
  validateDictionaryValues,
  type CrudDictionarySource,
} from './crud-dictionary.js';
import ExcelJS from 'exceljs';
import { PassThrough } from 'node:stream';
import { buildCrudSchema } from './crud-schema.js';
import { randomUUID } from 'node:crypto';
import { Brackets, type DataSource, type EntityManager } from 'typeorm';
import {
  INTERNAL_FIELDS,
  SYSTEM_FIELDS,
  type BaseEntity,
} from './base.entity.js';
import { Logger } from '@nestjs/common';
import { ScopedSelectQueryBuilder } from '../tenant/scoped-query-builder.js';
import { applyWhere } from './crud-query.js';
import {
  fieldVerdict,
  rawVisibleToAll,
  type FieldVerdict,
  type RowOwner,
} from '../field-perm/field-policy.js';
import { mask } from '../field-perm/masks.js';
import { escapeSpreadsheetCell } from '../security/sanitize.js';
import { crudErrors, translateDbError } from './crud.errors.js';
import type { CrudAudit } from './crud-audit.js';
import type { IdempotencyLedger } from '../security/idempotency.ledger.js';
import {
  attachDisplay,
  DISPLAY_FIELDS,
  type CrudDisplaySource,
} from './crud-display.js';
import type { AuthzContext } from '../permission/authz-context.js';
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
  /** 高级查询（T18，crud-query.ts） */
  where?: unknown;
}

export interface ExportQuery extends PageQuery {
  format?: 'csv' | 'xlsx';
  timeZone?: string;
  columns?: string[];
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
  /** 本次请求的授权（字段权限按行裁剪用） */
  authz: AuthzContext;
  /** 幂等记录账本（T25）：写事务提交前把幂等记录写进同一个事务 */
  idempotency: IdempotencyLedger;
  /** 列表显示名来源（系统模块注册；没有时只返回编号） */
  display: () => CrudDisplaySource | undefined;
  dictionary?: () => CrudDictionarySource | undefined;
  codes?: () => import('./crud-code.js').CrudCodeSource | undefined;
}

const ALIAS = 'e';
const SYSTEM = new Set<string>(SYSTEM_FIELDS);
/** 不受字段权限控制的输出字段：系统字段、版本号 */
const FIELD_PERM_EXEMPT = new Set<string>([...SYSTEM_FIELDS, 'version']);
const fieldLogger = new Logger('FieldPerm');
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

  /** 导出（T18）：最多这么多行，超过时只导出前面的 */
  static readonly EXPORT_MAX_ROWS = 10000;

  /** 两种格式共用列白名单、查询、逐行字段裁剪；不把隐藏字段重新读回原值。 */
  protected exportColumns(requested?: string[]): string[] {
    const ctx = this.crud.context.current();
    const authz = this.crud.authz.get();
    const allowed = this.meta.readable.filter(
      (f) =>
        FIELD_PERM_EXEMPT.has(f) ||
        ctx.endpoint === 'system' ||
        (authz &&
          fieldVerdict(
            authz,
            ctx.userId,
            this.meta.permPrefix,
            this.meta.entity,
            f,
            this.meta.dataScope && !participantField(this.meta.entity),
            null,
          ).state !== 'hidden'),
    );
    const defaults = buildCrudSchema(this.meta)
      .columns.filter((c) => !c.hidden)
      .map((c) => c.field);
    const columns = [...new Set(requested ?? defaults)];
    if (columns.some((f) => !this.meta.readable.includes(f)))
      throw crudErrors.badRequest('导出列不允许');
    const selected = columns.filter((f) => allowed.includes(f));
    if (!selected.length) throw crudErrors.badRequest('没有可导出的列');
    return selected;
  }

  private async *exportRows(query: PageQuery) {
    const size = 500;
    for (let page = 1, count = 0; count < BaseService.EXPORT_MAX_ROWS; page++) {
      const result = await this.page({ ...query, page }, size);
      for (const row of result.list) {
        if (count++ >= BaseService.EXPORT_MAX_ROWS) return;
        yield row as Record<string, unknown>;
      }
      if (result.list.length < size || count >= result.total) return;
    }
  }

  private async exportFormatter(query: ExportQuery) {
    try {
      new Intl.DateTimeFormat('zh-CN', { timeZone: query.timeZone });
    } catch {
      throw crudErrors.badRequest('时区不合法');
    }
    const schema = buildCrudSchema(this.meta);
    for (const field of this.meta.fields) {
      if (field.dictCode)
        schema.dictionaries[field.property] =
          (await this.crud.dictionary?.()?.options(field.dictCode)) ?? [];
    }
    return (row: Record<string, unknown>, field: string) =>
      exportValue(
        row,
        schema.columns.find((c) => c.field === field) ?? {
          field,
          label: field,
          sortable: false,
          type: 'text',
        },
        schema.dictionaries[field],
        query.timeZone,
      );
  }

  private exportCell(value: unknown): string {
    return escapeSpreadsheetCell(
      value == null
        ? ''
        : value instanceof Date
          ? value.toISOString()
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value as string | number | boolean | bigint),
    ) as string;
  }

  async exportCsv(query: ExportQuery): Promise<string> {
    const columns = this.exportColumns(query.columns);
    const display = await this.exportFormatter(query);
    const cell = (value: unknown) => {
      const text = this.exportCell(value);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [
      columns
        .map((f) =>
          cell(
            buildCrudSchema(this.meta).columns.find((x) => x.field === f)
              ?.label ?? f,
          ),
        )
        .join(','),
    ];
    for await (const row of this.exportRows(query))
      lines.push(columns.map((f) => cell(display(row, f))).join(','));
    return '\uFEFF' + lines.join('\r\n');
  }

  private xlsxCell(value: unknown): string | number | boolean {
    return typeof value === 'number' || typeof value === 'boolean'
      ? value
      : this.exportCell(value);
  }

  async exportXlsx(query: ExportQuery): Promise<PassThrough> {
    const columns = this.exportColumns(query.columns);
    const display = await this.exportFormatter(query);
    const rows = this.exportRows(query);
    // 首批先完成查询/权限检查，错误仍能以统一JSON响应，避免发出成功下载头之后才发现入参错误。
    const first = await rows.next();
    const output = new PassThrough();
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: output,
      useSharedStrings: false,
      useStyles: false,
    });
    const sheet = workbook.addWorksheet('数据');
    sheet
      .addRow(
        columns.map(
          (f) =>
            buildCrudSchema(this.meta).columns.find((x) => x.field === f)
              ?.label ?? f,
        ),
      )
      .commit();
    void (async () => {
      try {
        if (!first.done)
          sheet
            .addRow(columns.map((f) => this.xlsxCell(display(first.value, f))))
            .commit();
        for await (const row of rows) {
          if (output.destroyed) return;
          sheet
            .addRow(columns.map((f) => this.xlsxCell(display(row, f))))
            .commit();
        }
        sheet.commit();
        await workbook.commit();
      } catch (error) {
        output.destroy(error instanceof Error ? error : new Error('导出失败'));
      } finally {
        await rows.return(undefined);
      }
    })();
    return output;
  }

  async page(
    query: PageQuery,
    exportLimit?: number,
  ): Promise<PageResult<CrudRow<T>>> {
    const meta = this.meta;
    const page = query.page ?? 1;
    const size = exportLimit ?? query.size ?? 20;
    if (!exportLimit && size > meta.maxSize)
      throw crudErrors.badRequest(`每页最多 ${meta.maxSize} 条`, [
        { field: 'size', messages: [`每页最多 ${meta.maxSize} 条`] },
      ]);
    const qb = this.select(this.crud.dataSource.manager, 'page');

    // 脱敏、隐藏的字段不能按原值搜索：从搜索框的字段里去掉
    const canQuery = this.queryableByAll();
    const keyFields = meta.keyWords.filter(canQuery);
    const keyword = query.keyword?.trim();
    if (keyword && keyFields.length) {
      qb.andWhere(
        new Brackets((b) => {
          for (const f of keyFields)
            b.orWhere(`${ALIAS}.\`${this.column(f)}\` LIKE :__kw`);
        }),
        { __kw: `%${escapeLike(keyword)}%` },
      );
    }

    let i = 0;
    for (const [field, value] of Object.entries(query.eq ?? {})) {
      if (value === undefined) continue;
      if (!meta.fieldEq.includes(field) || !canQuery(field))
        throw crudErrors.badRequest('筛选字段不允许', [
          { field: `eq.${field}`, messages: ['这个字段不能用来筛选'] },
        ]);
      const c = `${ALIAS}.\`${this.column(field)}\``;
      if (value === null) qb.andWhere(`${c} IS NULL`);
      else qb.andWhere(`${c} = :__eq${i}`, { [`__eq${i}`]: value });
      i++;
    }

    applyWhere(qb, query.where, (field) => {
      if (!meta.fieldEq.includes(field) || !canQuery(field))
        throw crudErrors.badRequest('筛选字段不允许', [
          { field: 'where', messages: [`不能按 ${field} 筛选`] },
        ]);
      return `${ALIAS}.\`${this.column(field)}\``;
    });

    const sort = query.sort?.length ? query.sort : meta.defaultSort;
    for (const s of sort) {
      if (!meta.sortable.includes(s.field) || !canQuery(s.field))
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
    const list = rows.map((r) => this.toRow(r));
    await this.withDisplay(list);
    return { list, total, page, size };
  }

  async info(id: string): Promise<CrudRow<T>> {
    const manager = this.crud.dataSource.manager;
    const row = await this.findOne(manager, id, 'info');
    if (!row) throw crudErrors.notFound();
    const out = await this.toDetail(
      manager,
      row,
      this.crud.context.current().tenantId,
    );
    await this.withDisplay([out]);
    return out;
  }

  /** 给返回的行补创建人、修改人、所属组织的显示名（_display） */
  protected async withDisplay(rows: object[]): Promise<void> {
    await attachDisplay(
      this.crud.display(),
      this.crud.context.current().tenantId,
      rows as Record<string, unknown>[],
      {
        ...DISPLAY_FIELDS,
        ...Object.fromEntries(
          this.meta.fields.flatMap((f) =>
            f.display ? [[f.property, f.display] as const] : [],
          ),
        ),
      },
    );
  }

  /** 树形列表最多这么多个节点；超过说明不适合一次加载，要改成按层加载 */
  static readonly TREE_MAX_NODES = 5000;

  /**
   * 树形列表（树形资源）：全部可见节点平铺返回，同级按排序字段、再按编号从小到大。
   * 数据范围同样生效：看不见父节点的节点在前端当作根节点显示。
   */
  async tree(): Promise<{ list: CrudRow<T>[] }> {
    const tree = this.assertTree();
    const qb = this.select(this.crud.dataSource.manager, 'page');
    if (tree.sortField)
      qb.addOrderBy(`${ALIAS}.\`${this.column(tree.sortField)}\``, 'ASC');
    qb.addOrderBy(`${ALIAS}.id`, 'ASC');
    const rows = await qb.limit(BaseService.TREE_MAX_NODES + 1).getMany();
    if (rows.length > BaseService.TREE_MAX_NODES)
      throw crudErrors.badRequest(
        `节点超过 ${BaseService.TREE_MAX_NODES} 个，不能一次加载`,
      );
    const list = rows.map((r) => this.toRow(r));
    await this.withDisplay(list);
    return { list };
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
      this.dropChildNotEditable(plans, {
        orgId: tx.ctx.orgId,
        createdBy: tx.ctx.userId,
      });
      // 字段权限：新增的这一行属于当前组织、创建人是自己
      this.dropNotEditable(values, {
        orgId: tx.ctx.orgId,
        createdBy: tx.ctx.userId,
      });
      this.assertNullable(values);
      await this.beforeAdd(values, tx);
      await fillCodeFields(this.crud.codes?.(), tx.manager, [
        {
          resource: this.meta.prefix,
          fields: this.meta.fields,
          rows: [values as Record<string, unknown>],
        },
        ...plans.map((p) => ({
          resource: `${this.meta.prefix}/${p.child.resource}`,
          fields: p.child.fields,
          rows: p.added.map((r) => r.values),
        })),
      ]);
      await validateDictionaryValues(
        this.crud.dictionary?.(),
        this.meta.fields,
        values as Record<string, unknown>,
        tx.manager,
      );
      await this.checkTreeParent(tx, null, values);
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
      // 子表字段权限按主表这一行的归属判断
      this.dropChildNotEditable(plans, existing as unknown as RowOwner);
      if (!existing) throw crudErrors.notFound();
      if (existing.version !== version) throw crudErrors.versionConflict();
      const changes = this.pick(data, this.meta.updatable);
      this.dropNotEditable(changes, existing as unknown as RowOwner);
      this.assertNullable(changes);
      await this.beforeUpdate(changes, existing, tx);
      await fillCodeFields(
        this.crud.codes?.(),
        tx.manager,
        plans.map((p) => ({
          resource: `${this.meta.prefix}/${p.child.resource}`,
          fields: p.child.fields,
          rows: p.added.map((r) => r.values),
        })),
      );
      await validateDictionaryValues(
        this.crud.dictionary?.(),
        this.meta.fields,
        changes as Record<string, unknown>,
        tx.manager,
      );
      await this.checkTreeParent(tx, id, changes);
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
      await this.checkTreeLeaves(tx, unique);
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
    const list = rows.map((r) => ({
      ...this.toRow(r),
      deletedAt: r.deletedAt as Date,
    }));
    await this.withDisplay(list);
    return {
      list,
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
      await this.checkTreeRestore(tx, rows);
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

  // ---------- 树形资源 ----------

  private assertTree() {
    const tree = this.meta.tree;
    if (!tree) throw new Error(`${this.meta.prefix} 不是树形资源`);
    return tree;
  }

  /** 只按租户查（不按数据范围）：成环、有没有下级要看整棵树，包括当前用户看不见的节点 */
  private tenantTree(tx: CrudTx) {
    return tx.manager
      .createQueryBuilder(this.meta.entity, 't')
      .where('t.`tenant_id` = :__tid', { __tid: tx.ctx.tenantId })
      .andWhere('t.`deleted_at` IS NULL');
  }

  /**
   * 新增、修改时的父节点校验：父节点要存在且当前用户看得见，不能是自己，不能是自己的下级（成环）。
   * values 里没有父级字段时（修改时没改父节点）不检查；null 表示根节点。
   */
  private async checkTreeParent(
    tx: CrudTx,
    id: string | null,
    values: Partial<T>,
  ): Promise<void> {
    const tree = this.meta.tree;
    if (!tree || !Object.hasOwn(values, tree.parentField)) return;
    const raw = (values as Record<string, unknown>)[tree.parentField];
    if (raw === null || raw === undefined || raw === '') {
      (values as Record<string, unknown>)[tree.parentField] = null;
      return;
    }
    const parentId = String(raw as string);
    const bad = (message: string) =>
      crudErrors.badRequest(message, [
        { field: `data.${tree.parentField}`, messages: [message] },
      ]);
    if (id !== null && parentId === id) throw bad('上级不能是自己');
    if (!(await this.findOne(tx.manager, parentId, id ? 'update' : 'add')))
      throw bad('上级节点不存在或没有权限');
    if (id === null) return;
    const col = this.column(tree.parentField);
    let current: string | null = parentId;
    for (let depth = 0; current; depth++) {
      if (depth >= 100) throw bad('层级太深（超过 100 层）');
      const row: { p: string | null } | undefined = await this.tenantTree(tx)
        .select(`t.\`${col}\``, 'p')
        .andWhere('t.id = :__cur', { __cur: current })
        .getRawOne();
      current = row?.p != null ? String(row.p) : null;
      if (current === id) throw bad('不能把节点移到它自己的下级');
    }
  }

  /** 有下级的节点不能删除；同一批里连同下级一起删可以 */
  private async checkTreeLeaves(tx: CrudTx, ids: string[]): Promise<void> {
    const tree = this.meta.tree;
    if (!tree) return;
    const col = this.column(tree.parentField);
    const child = await this.tenantTree(tx)
      .andWhere(`t.\`${col}\` IN (:...__ids)`, { __ids: ids })
      .andWhere('t.id NOT IN (:...__ids)', { __ids: ids })
      .getCount();
    if (child)
      throw crudErrors.badRequest('有下级节点，不能删除，请先删除或移走下级');
  }

  /** 恢复时上级必须是有效的（没删除），或者在同一批里一起恢复 */
  private async checkTreeRestore(tx: CrudTx, rows: T[]): Promise<void> {
    const tree = this.meta.tree;
    if (!tree) return;
    const batch = new Set(rows.map((r) => String(r.id)));
    const parents = [
      ...new Set(
        rows
          .map((r) => (r as Record<string, unknown>)[tree.parentField])
          .filter((p) => p !== null && p !== undefined)
          .map((p) => String(p as string))
          .filter((p) => !batch.has(p)),
      ),
    ];
    if (!parents.length) return;
    const alive = await this.tenantTree(tx)
      .andWhere('t.id IN (:...__ps)', { __ps: parents })
      .getCount();
    if (alive !== parents.length)
      throw crudErrors.badRequest('上级节点已删除，请先恢复上级');
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
        orgId: tx.ctx.orgId,
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
      return await this.crud.idempotency.transaction((manager) =>
        fn({
          manager,
          ctx,
          meta: meta as CrudResourceMeta,
          dictionary: this.crud.dictionary?.(),
        }),
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
    if (this.meta.children.length) {
      const children = await loadChildren(
        manager,
        this.meta as CrudResourceMeta,
        tenantId,
        String(row.id),
      );
      // 子表字段权限（T16）：资源是「主表前缀.子表名」，按主表这一行的归属判断
      const src = row as unknown as Record<string, unknown>;
      const owner: RowOwner = {
        orgId: (src.orgId as string | null | undefined) ?? null,
        createdBy: (src.createdBy as string | null | undefined) ?? null,
      };
      for (const child of this.meta.children) {
        const verdict = this.childAccess(child, owner);
        if (!verdict) continue;
        for (const r of children[child.resource] ?? []) {
          const states: Record<string, string> = {};
          for (const k of Object.keys(r)) {
            if (FIELD_PERM_EXEMPT.has(k) || k === child.foreignKey) continue;
            const v = verdict(k);
            if (v.state === 'editable') continue;
            states[k] = v.state;
            if (v.state === 'hidden') delete r[k];
            else if (v.state === 'masked') r[k] = mask(r[k], v.mask);
          }
          if (Object.keys(states).length) r._fieldState = states;
        }
      }
      out.children = children;
    }
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
    // T16 逐行字段权限：隐藏的不返回，脱敏的打码
    const verdict = this.fieldAccess({
      orgId: (src.orgId as string | null | undefined) ?? null,
      createdBy: (src.createdBy as string | null | undefined) ?? null,
    });
    if (verdict) {
      // _fieldState：这一行上不是「可编辑」的字段及其状态（契约 field-perm.md 3.1），前端据此逐行禁用编辑、标出打码
      const states: Record<string, string> = {};
      for (const k of Object.keys(out)) {
        if (FIELD_PERM_EXEMPT.has(k)) continue;
        const v = verdict(k);
        if (v.state === 'editable') continue;
        states[k] = v.state;
        if (v.state === 'hidden') delete out[k];
        else if (v.state === 'masked') out[k] = mask(out[k], v.mask);
      }
      // 全部可编辑时不带这个键
      if (Object.keys(states).length) out._fieldState = states;
    }
    return out as CrudRow<T>;
  }

  /**
   * 这一行的字段权限判断函数；后台任务（system 端）不受字段权限限制，返回 null。
   * 后台请求没有授权结果（@LoginOnly 接口）时一律隐藏（失败关闭）。
   */
  private fieldAccess(row: RowOwner): ((field: string) => FieldVerdict) | null {
    const ctx = this.crud.context.current();
    if (ctx.endpoint === 'system') return null;
    const authz = this.crud.authz.get();
    return (field) =>
      authz
        ? fieldVerdict(
            authz,
            ctx.userId,
            this.meta.permPrefix,
            this.meta.entity,
            field,
            this.meta.dataScope && !participantField(this.meta.entity),
            row,
          )
        : { state: 'hidden', mask: null };
  }

  /**
   * 这个字段能不能用来排序、筛选、搜索：后台任务不限；系统字段不受字段权限控制；
   * 其他字段要本次有效角色全部能看原值（T18）。没有授权结果时一律不行。
   */
  private queryableByAll(): (field: string) => boolean {
    const ctx = this.crud.context.current();
    if (ctx.endpoint === 'system') return () => true;
    const authz = this.crud.authz.get();
    return (field) =>
      FIELD_PERM_EXEMPT.has(field) ||
      (!!authz &&
        rawVisibleToAll(authz, this.meta.permPrefix, this.meta.entity, field));
  }

  /** 子表字段的判断函数：资源 = 主表权限前缀 + . + 子表名，归属看主表这一行 */
  private childAccess(
    child: { resource: string; entity: Function },
    owner: RowOwner,
  ): ((field: string) => FieldVerdict) | null {
    const ctx = this.crud.context.current();
    if (ctx.endpoint === 'system') return null;
    const authz = this.crud.authz.get();
    return (field) =>
      authz
        ? fieldVerdict(
            authz,
            ctx.userId,
            `${this.meta.permPrefix}.${child.resource}`,
            child.entity,
            field,
            this.meta.dataScope,
            owner,
          )
        : { state: 'hidden', mask: null };
  }

  /** 子表新增、修改的行：剔除不可编辑的字段并记日志 */
  private dropChildNotEditable(
    plans: {
      child: { resource: string; entity: Function };
      added: { values: Record<string, unknown> }[];
      updated: { values: Record<string, unknown> }[];
    }[],
    owner: RowOwner,
  ): void {
    for (const p of plans) {
      const verdict = this.childAccess(p.child, owner);
      if (!verdict) return;
      const dropped = new Set<string>();
      for (const r of [...p.added, ...p.updated])
        for (const k of Object.keys(r.values))
          if (!FIELD_PERM_EXEMPT.has(k) && verdict(k).state !== 'editable') {
            delete r.values[k];
            dropped.add(k);
          }
      if (dropped.size)
        fieldLogger.warn({
          event: 'field-perm.write-dropped',
          resource: `${this.meta.permPrefix}.${p.child.resource}`,
          fields: [...dropped],
        });
    }
  }

  /** 写入前剔除这一行上不可编辑的字段，并记日志（架构「字段权限 · 后端强制执行」） */
  private dropNotEditable(data: Partial<T>, row: RowOwner): void {
    const verdict = this.fieldAccess(row);
    if (!verdict) return;
    const values = data as Record<string, unknown>;
    const dropped = Object.keys(values).filter(
      (k) => !FIELD_PERM_EXEMPT.has(k) && verdict(k).state !== 'editable',
    );
    for (const k of dropped) delete values[k];
    if (dropped.length)
      fieldLogger.warn({
        event: 'field-perm.write-dropped',
        resource: this.meta.permPrefix,
        fields: dropped,
      });
  }
}
