import { randomUUID } from 'node:crypto';
import type { Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import type { DataSource, EntityManager } from 'typeorm';
import { SYSTEM_FIELDS } from './base.entity.js';
import { ID_PATTERN, MAX_BATCH } from './crud.dto.js';
import { crudErrors, type CrudFieldError } from './crud.errors.js';
import type { CrudChildMeta, CrudResourceMeta, CrudTx } from './crud.types.js';

/**
 * 主子表聚合保存（架构「通用 CRUD · 主子表」、T03 补充验收）。
 *
 * 规则：
 * - 每个子表分三组提交：added（新增，带 clientId）、updated（修改，带 id，只传要改的字段）、deleted（要删除的 id）；
 *   没提交的行保持不动，不会因为「这次没传」就被删掉；
 * - 子行必须属于这张主表（同租户、同主表编号、未删除），不属于和不存在给同样的错误；
 * - 子表的任何修改都在主表的事务里，主表版本号加 1，并发以主表版本号为准；
 * - 行数上下限、同一张单据里不能重复的字段，按保存后的完整结果检查；
 * - 有任何一个错误，整个保存都不执行。
 */

type Values = Record<string, unknown>;

export interface ChildPlan {
  child: CrudChildMeta;
  added: { clientId: string; values: Values }[];
  updated: { id: string; values: Values }[];
  deleted: string[];
}

const SYSTEM = new Set<string>(SYSTEM_FIELDS);
const ALIAS = 'c';
const ROWS_FIELD = '_rows';

const isObject = (v: unknown): v is Values =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function flatten(
  errors: ValidationError[],
  parent = '',
): { field: string; messages: string[] }[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = e.constraints
      ? [{ field, messages: Object.values(e.constraints) }]
      : [];
    return [...own, ...flatten(e.children ?? [], field)];
  });
}

async function validateRow(
  dto: Type,
  row: unknown,
): Promise<{ field: string; messages: string[] }[]> {
  if (!isObject(row))
    return [{ field: ROWS_FIELD, messages: ['每一行必须是对象'] }];
  const instance = plainToInstance(dto, row) as object;
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  return flatten(errors);
}

/** 非空列显式传 null 的字段 */
function nullViolations(
  dataSource: DataSource,
  child: CrudChildMeta,
  values: Values,
): { field: string; messages: string[] }[] {
  const em = dataSource.getMetadata(child.entity);
  return Object.entries(values)
    .filter(
      ([k, v]) => v === null && !em.findColumnWithPropertyName(k)?.isNullable,
    )
    .map(([k]) => ({
      field: k,
      messages: [
        `${child.fields.find((f) => f.property === k)?.label ?? k}不能为空`,
      ],
    }));
}

const pick = (row: Values, allowed: string[]): Values => {
  const out: Values = {};
  for (const k of allowed)
    if (row[k] !== undefined && !SYSTEM.has(k)) out[k] = row[k];
  return out;
};

/**
 * 第一步（不碰数据库）：检查请求结构和每一行的字段，整理成保存计划。
 * mode 为 add 时只允许 added。
 */
export async function planChildren(
  meta: CrudResourceMeta,
  raw: unknown,
  mode: 'add' | 'update',
  dataSource: DataSource,
): Promise<ChildPlan[]> {
  const errors: CrudFieldError[] = [];
  const plans: ChildPlan[] = [];
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw))
    throw crudErrors.badRequest('请求参数有误', [
      { field: 'children', messages: ['children 必须是对象'] },
    ]);

  for (const key of Object.keys(raw))
    if (!meta.children.some((c) => c.resource === key))
      errors.push({ field: `children.${key}`, messages: ['没有这个子表'] });

  for (const child of meta.children) {
    const change = raw[child.resource];
    if (change === undefined) continue;
    const resource = child.resource;
    const at = (e: Omit<CrudFieldError, 'resource'>) =>
      errors.push({ resource, ...e });
    if (!isObject(change)) {
      at({ field: ROWS_FIELD, messages: ['子表的提交内容必须是对象'] });
      continue;
    }
    const allowedKeys =
      mode === 'add' ? ['added'] : ['added', 'updated', 'deleted'];
    for (const k of Object.keys(change))
      if (!allowedKeys.includes(k))
        at({
          field: k,
          messages: [
            mode === 'add'
              ? '新增时子表只能提交 added'
              : '只能提交 added、updated、deleted',
          ],
        });

    const list = (k: string): unknown[] => {
      const v = change[k];
      if (v === undefined) return [];
      if (!Array.isArray(v)) {
        at({ field: k, messages: [`${k} 必须是数组`] });
        return [];
      }
      if (v.length > MAX_BATCH) {
        at({ field: k, messages: [`${k} 一次最多 ${MAX_BATCH} 行`] });
        return [];
      }
      return v;
    };
    const plan: ChildPlan = { child, added: [], updated: [], deleted: [] };
    const dtos = child.rowDtos!;

    // 新增行：clientId 必填、非空字符串、本子表内唯一；它只用来定位错误，不入库
    const seenClient = new Set<string>();
    const added = list('added');
    for (let index = 0; index < added.length; index++) {
      const row = added[index];
      const cid =
        isObject(row) && typeof row.clientId === 'string' && row.clientId.trim()
          ? row.clientId
          : undefined;
      const where =
        cid !== undefined && !seenClient.has(cid)
          ? { clientId: cid }
          : { index };
      if (
        isObject(row) &&
        typeof row.clientId === 'string' &&
        cid === undefined
      )
        at({ index, field: 'clientId', messages: ['clientId 不能只有空白'] });
      if (cid !== undefined && seenClient.has(cid))
        at({
          index,
          clientId: cid,
          field: 'clientId',
          messages: ['clientId 在本次提交里重复'],
        });
      if (cid !== undefined) seenClient.add(cid);
      const rowErrors = await validateRow(dtos.AddRow, row);
      for (const e of rowErrors) at({ ...where, ...e });
      if (!rowErrors.length && isObject(row)) {
        const values = pick(row, child.addable);
        for (const e of nullViolations(dataSource, child, values))
          at({ ...where, ...e });
        plan.added.push({ clientId: cid!, values });
      }
    }

    const seenId = new Set<string>();
    for (const row of list('updated')) {
      const id =
        isObject(row) && typeof row.id === 'string' ? row.id : undefined;
      const where = id ? { id } : {};
      if (id && seenId.has(id))
        at({ id, field: 'id', messages: ['同一行在 updated 里出现了多次'] });
      if (id) seenId.add(id);
      const rowErrors = await validateRow(dtos.UpdateRow, row);
      for (const e of rowErrors) at({ ...where, ...e });
      if (!rowErrors.length && id) {
        const values = pick(row as Values, child.updatable);
        for (const e of nullViolations(dataSource, child, values))
          at({ id, ...e });
        plan.updated.push({ id, values });
      }
    }

    for (const id of list('deleted')) {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        at({ field: 'deleted', messages: ['要删除的行编号格式不正确'] });
        continue;
      }
      if (plan.deleted.includes(id))
        at({ id, field: 'id', messages: ['同一行在 deleted 里出现了多次'] });
      else if (seenId.has(id))
        at({ id, field: 'id', messages: ['同一行不能同时修改和删除'] });
      else plan.deleted.push(id);
    }
    plans.push(plan);
  }
  if (errors.length)
    throw crudErrors.badRequest('明细有误，请修正标红的行', errors);
  return plans;
}

/** 子表查询：只按租户 + 主表编号，访问权限跟随主表（能操作主表才能到这里） */
function childQuery(
  manager: EntityManager,
  child: CrudChildMeta,
  tenantId: string,
  masterIds: string[],
) {
  const fk = manager.connection
    .getMetadata(child.entity)
    .findColumnWithPropertyName(child.foreignKey)!.databaseName;
  return manager
    .createQueryBuilder(child.entity, ALIAS)
    .where(`${ALIAS}.\`tenant_id\` = :__tenantId`, { __tenantId: tenantId })
    .andWhere(`${ALIAS}.\`${fk}\` IN (:...__masterIds)`, {
      __masterIds: masterIds,
    });
}

function toChildRow(child: CrudChildMeta, row: object): Values {
  const src = row as Values;
  const out: Values = {};
  for (const k of child.readable) if (k in src) out[k] = src[k];
  return out;
}

/** 详情里的子表数据，按排序字段、编号从小到大 */
export async function loadChildren(
  manager: EntityManager,
  meta: CrudResourceMeta,
  tenantId: string,
  masterId: string,
): Promise<Record<string, Values[]>> {
  const out: Record<string, Values[]> = {};
  for (const child of meta.children) {
    const qb = childQuery(manager, child, tenantId, [masterId]);
    if (child.sortField)
      qb.orderBy(`${ALIAS}.${child.sortField}`, 'ASC').addOrderBy(
        `${ALIAS}.id`,
        'ASC',
      );
    else qb.orderBy(`${ALIAS}.id`, 'ASC');
    out[child.resource] = (await qb.getMany()).map((r) => toChildRow(child, r));
  }
  return out;
}

/** 数据库会补、但写入前算不出来的默认值（如 SQL 表达式），唯一检查交给写入后的复核 */
const UNKNOWN = Symbol('unknown-default');

/**
 * 新增行省略的字段按数据库最终会存的值补上：常量默认值直接用，可空列算 null，
 * SQL 表达式默认值标成「未知」，由写入后的数据库复核兜底。
 */
function withDefaults(
  tx: CrudTx,
  child: CrudChildMeta,
  values: Values,
): Values {
  const em = tx.manager.connection.getMetadata(child.entity);
  const out: Values = { ...values };
  for (const group of child.unique)
    for (const f of group) {
      if (out[f] !== undefined) continue;
      const col = em.findColumnWithPropertyName(f);
      const d: unknown = col?.default;
      if (
        typeof d === 'string' ||
        typeof d === 'number' ||
        typeof d === 'boolean'
      )
        out[f] = d;
      else if (d === undefined && col?.isNullable) out[f] = null;
      else out[f] = UNKNOWN;
    }
  return out;
}

/** 唯一键：有空值的不参与唯一（和数据库唯一约束一致）；有算不出来的默认值时返回 UNKNOWN */
const valueKey = (
  row: Values,
  group: string[],
): string | null | typeof UNKNOWN =>
  group.some((f) => row[f] === UNKNOWN)
    ? UNKNOWN
    : group.some((f) => row[f] === null || row[f] === undefined)
      ? null
      : JSON.stringify(group.map((f) => String(row[f])));

/**
 * 第二步（在主表事务里，主表这一行已加锁或刚刚新建）：核对子行归属，按保存后的完整结果检查行数和唯一，然后写入。
 * 先把所有检查做完再动数据，有错误就整批不写。
 */
export async function saveChildren(
  tx: CrudTx,
  meta: CrudResourceMeta,
  masterId: string,
  plans: ChildPlan[],
  isNew = false,
): Promise<void> {
  const errors: CrudFieldError[] = [];
  const work: { plan: ChildPlan; current: Map<string, Values> }[] = [];

  for (const plan of plans) {
    const { child } = plan;
    const resource = child.resource;
    // 主表这一行已经被锁住，所有子表写入都要先拿到它，所以这里普通读取就是一致的；
    // 不对子表加锁，避免外键索引上的间隙锁让并发保存互相死锁。新建的单据还没有明细，不用查
    const rows = isNew
      ? []
      : await childQuery(tx.manager, child, tx.ctx.tenantId, [
          masterId,
        ]).getMany();
    const current = new Map(
      rows.map((r) => [
        String((r as unknown as Values).id),
        r as unknown as Values,
      ]),
    );

    for (const { id } of plan.updated)
      if (!current.has(id))
        errors.push({
          resource,
          id,
          field: 'id',
          messages: ['明细不存在或不属于这张单据'],
        });
    for (const id of plan.deleted)
      if (!current.has(id))
        errors.push({
          resource,
          id,
          field: 'id',
          messages: ['明细不存在或不属于这张单据'],
        });

    // 保存后的完整结果：现有行 - 删除 + 修改 + 新增
    type Final = { row: Values; where: { id: string } | { clientId: string } };
    const final: Final[] = [];
    const updates = new Map(plan.updated.map((u) => [u.id, u.values]));
    for (const [id, row] of current)
      if (!plan.deleted.includes(id))
        final.push({
          row: { ...row, ...updates.get(id) },
          where: { id },
        });
    for (const a of plan.added)
      final.push({
        row: withDefaults(tx, child, a.values),
        where: { clientId: a.clientId },
      });

    if (final.length < child.min || final.length > child.max)
      errors.push({
        resource,
        field: ROWS_FIELD,
        messages: [
          final.length < child.min
            ? `${child.label}至少要有 ${child.min} 行`
            : `${child.label}最多 ${child.max} 行`,
        ],
      });

    for (const group of child.unique) {
      const byKey = new Map<string, Final[]>();
      for (const f of final) {
        const k = valueKey(f.row, group);
        if (typeof k === 'string') byKey.set(k, [...(byKey.get(k) ?? []), f]);
      }
      const labels = group
        .map((p) => child.fields.find((x) => x.property === p)?.label ?? p)
        .join('、');
      for (const dup of byKey.values())
        if (dup.length > 1)
          for (const f of dup)
            // 只标出本次提交涉及的行；没动的已有行也重复时标出它，方便用户找到
            errors.push({
              resource,
              ...f.where,
              field: group[0],
              messages: [`同一张单据里${labels}不能重复`],
            });
    }
    work.push({ plan, current });
  }
  if (errors.length)
    throw crudErrors.badRequest('明细有误，请修正标红的行', errors);

  for (const { plan } of work) {
    const { child } = plan;
    const em = tx.manager.connection.getMetadata(child.entity);
    const fk = em.findColumnWithPropertyName(child.foreignKey)!.databaseName;
    const scope = (qb: { andWhere: (s: string, p?: object) => unknown }) => {
      qb.andWhere('`tenant_id` = :__tenantId', { __tenantId: tx.ctx.tenantId });
      qb.andWhere(`\`${fk}\` = :__masterId`, { __masterId: masterId });
      qb.andWhere('`deleted_at` IS NULL');
    };

    if (plan.deleted.length) {
      const del =
        meta.deleteMode === 'soft'
          ? tx.manager
              .createQueryBuilder()
              .update(child.entity)
              .set({
                deletedAt: () => 'CURRENT_TIMESTAMP(3)',
                // 单独删掉的明细自成一批，恢复主表时不会被一起复活
                deleteBatch: randomUUID(),
                updatedBy: tx.ctx.userId,
                updatedAt: () => 'CURRENT_TIMESTAMP(3)',
              } as never)
          : tx.manager.createQueryBuilder().delete().from(child.entity);
      del.where('`id` IN (:...__ids)', { __ids: plan.deleted });
      scope(del);
      const r = await del.execute();
      if (r.affected !== plan.deleted.length)
        throw crudErrors.versionConflict();
    }

    for (const u of plan.updated) {
      const qb = tx.manager
        .createQueryBuilder()
        .update(child.entity)
        .set({
          ...u.values,
          updatedBy: tx.ctx.userId,
          updatedAt: () => 'CURRENT_TIMESTAMP(3)',
        } as never)
        .where('`id` = :__id', { __id: u.id });
      scope(qb);
      const r = await qb.execute();
      if (r.affected !== 1) throw crudErrors.versionConflict();
    }

    // 逐行插入，记下 clientId 对应的新编号，写入后复核时能把错误定位回新增行
    const inserted = new Map<string, string>();
    for (const a of plan.added) {
      const r = await tx.manager
        .createQueryBuilder()
        .insert()
        .into(child.entity)
        .values({
          ...a.values,
          [child.foreignKey]: masterId,
          tenantId: tx.ctx.tenantId,
          createdBy: tx.ctx.userId,
          updatedBy: tx.ctx.userId,
        } as never)
        .execute();
      inserted.set(String(r.identifiers[0]?.id), a.clientId);
    }
    if (child.unique.length) await recheckUnique(tx, child, masterId, inserted);
  }
}

/**
 * 写入后在同一事务里按数据库实际存下的值再查一次重复：覆盖写入前算不出的默认值，
 * 以及数据库排序规则下视为相同的值（如大小写不同）。发现重复就抛错，整个保存回滚。
 */
async function recheckUnique(
  tx: CrudTx,
  child: CrudChildMeta,
  masterId: string,
  inserted: Map<string, string>,
): Promise<void> {
  const errors: CrudFieldError[] = [];
  const em = tx.manager.connection.getMetadata(child.entity);
  for (const group of child.unique) {
    const cols = group.map(
      (p) => em.findColumnWithPropertyName(p)!.databaseName,
    );
    const qb = childQuery(tx.manager, child, tx.ctx.tenantId, [masterId])
      .select(`GROUP_CONCAT(${ALIAS}.\`id\`)`, 'ids')
      .groupBy(cols.map((c) => `${ALIAS}.\`${c}\``).join(', '))
      .having('COUNT(*) > 1');
    for (const c of cols) qb.andWhere(`${ALIAS}.\`${c}\` IS NOT NULL`);
    const dups = await qb.getRawMany<{ ids: string }>();
    const labels = group
      .map((p) => child.fields.find((x) => x.property === p)?.label ?? p)
      .join('、');
    for (const d of dups)
      for (const id of String(d.ids).split(',')) {
        const clientId = inserted.get(id);
        errors.push({
          resource: child.resource,
          ...(clientId !== undefined ? { clientId } : { id }),
          field: group[0],
          messages: [`同一张单据里${labels}不能重复`],
        });
      }
  }
  if (errors.length)
    throw crudErrors.badRequest('明细有误，请修正标红的行', errors);
}

/** 删除主表时子表一起处理，跟随主表的删除方式；软删除时和主表同一个删除批次 */
export async function deleteChildrenOf(
  tx: CrudTx,
  meta: CrudResourceMeta,
  masterIds: string[],
  batch: string,
): Promise<void> {
  for (const child of meta.children) {
    const fk = childFk(tx.manager, child);
    const qb =
      meta.deleteMode === 'soft'
        ? tx.manager
            .createQueryBuilder()
            .update(child.entity)
            .set({
              deletedAt: () => 'CURRENT_TIMESTAMP(3)',
              deleteBatch: batch,
              updatedBy: tx.ctx.userId,
              updatedAt: () => 'CURRENT_TIMESTAMP(3)',
            } as never)
        : tx.manager.createQueryBuilder().delete().from(child.entity);
    await qb
      .where(`\`${fk}\` IN (:...__ids)`, { __ids: masterIds })
      .andWhere('`tenant_id` = :__tenantId', { __tenantId: tx.ctx.tenantId })
      .andWhere('`deleted_at` IS NULL')
      .execute();
  }
}

const childFk = (manager: EntityManager, child: CrudChildMeta) =>
  manager.connection
    .getMetadata(child.entity)
    .findColumnWithPropertyName(child.foreignKey)!.databaseName;

/** 硬删除前留底用：这些主表下的子行整行内容（includeDeleted 时连已删除的也取） */
export async function childRowsOf(
  tx: CrudTx,
  meta: CrudResourceMeta,
  masterIds: string[],
  includeDeleted: boolean,
): Promise<Record<string, object[]>> {
  const out: Record<string, object[]> = {};
  for (const child of meta.children) {
    const qb = childQuery(tx.manager, child, tx.ctx.tenantId, masterIds)
      .addSelect(`${ALIAS}.deleteBatch`)
      .orderBy(`${ALIAS}.id`, 'ASC');
    if (includeDeleted) qb.withDeleted();
    out[child.resource] = await qb.getMany();
  }
  return out;
}

/** 恢复主表：只恢复和主表同一删除批次的子行，之前单独删掉的明细仍在回收站 */
export async function restoreChildrenOf(
  tx: CrudTx,
  meta: CrudResourceMeta,
  masters: { id: string; batch: string | null }[],
): Promise<void> {
  for (const child of meta.children) {
    const fk = childFk(tx.manager, child);
    for (const m of masters) {
      if (!m.batch) continue;
      await tx.manager
        .createQueryBuilder()
        .update(child.entity)
        .set({
          deletedAt: null,
          deleteBatch: null,
          updatedBy: tx.ctx.userId,
          updatedAt: () => 'CURRENT_TIMESTAMP(3)',
        } as never)
        .where(`\`${fk}\` = :__id`, { __id: m.id })
        .andWhere('`tenant_id` = :__tenantId', { __tenantId: tx.ctx.tenantId })
        .andWhere('`delete_batch` = :__batch', { __batch: m.batch })
        .andWhere('`deleted_at` IS NOT NULL')
        .execute();
    }
  }
}

/** 彻底删除主表：它名下的子行（不管有没有删除）一起真删 */
export async function purgeChildrenOf(
  tx: CrudTx,
  meta: CrudResourceMeta,
  masterIds: string[],
): Promise<void> {
  for (const child of meta.children)
    await tx.manager
      .createQueryBuilder()
      .delete()
      .from(child.entity)
      .where(`\`${childFk(tx.manager, child)}\` IN (:...__ids)`, {
        __ids: masterIds,
      })
      .andWhere('`tenant_id` = :__tenantId', { __tenantId: tx.ctx.tenantId })
      .execute();
}
