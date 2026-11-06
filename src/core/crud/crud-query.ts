import { Brackets, type WhereExpressionBuilder } from 'typeorm';
import { crudErrors } from './crud.errors.js';

/**
 * 高级查询统一格式（T18，契约 docs/contracts/query.md）：
 * `{ op: 'and' | 'or', items: [ { field, op, value } | 子分组 ] }`，最多 3 层、共 30 个条件。
 * 运算符走白名单，值一律参数化，字段只能是资源声明可筛选、且本次有效角色全部能看原值的字段。
 */
export type QueryOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'notIn'
  | 'contains'
  | 'startsWith'
  | 'between'
  | 'isNull'
  | 'notNull';

export interface QueryCondition {
  field: string;
  op: QueryOp;
  value?: unknown;
}

export interface QueryGroup {
  op: 'and' | 'or';
  items: (QueryCondition | QueryGroup)[];
}

const OPS = new Set<QueryOp>([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'contains',
  'startsWith',
  'between',
  'isNull',
  'notNull',
]);
const MAX_DEPTH = 3;
const MAX_CONDITIONS = 30;
const MAX_IN = 100;

const bad = (msg: string) =>
  crudErrors.badRequest(msg, [{ field: 'where', messages: [msg] }]);

const isScalar = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * 把查询条件加到查询构造器上。column(field) 给出真实列名（已核对字段可筛选、可看原值），
 * 不合格的字段由它直接抛错。
 */
export function applyWhere(
  qb: WhereExpressionBuilder,
  where: unknown,
  column: (field: string) => string,
): void {
  if (where === undefined || where === null) return;
  let count = 0;
  let n = 0;
  const param = () => `__q${n++}`;

  const group = (g: unknown, depth: number): Brackets => {
    if (depth > MAX_DEPTH) throw bad(`查询条件最多 ${MAX_DEPTH} 层`);
    const node = g as QueryGroup;
    if (
      !node ||
      typeof node !== 'object' ||
      (node.op !== 'and' && node.op !== 'or') ||
      !Array.isArray(node.items) ||
      node.items.length === 0
    )
      throw bad('查询条件格式不对：分组要有 op（and / or）和非空的 items');
    return new Brackets((b) => {
      for (const item of node.items) {
        const add = (
          cond: string | Brackets,
          params?: Record<string, unknown>,
        ) => {
          if (typeof cond !== 'string') {
            if (node.op === 'and') b.andWhere(cond);
            else b.orWhere(cond);
          } else if (node.op === 'and') b.andWhere(cond, params);
          else b.orWhere(cond, params);
        };
        if (item && typeof item === 'object' && 'items' in item) {
          add(group(item, depth + 1));
          continue;
        }
        if (++count > MAX_CONDITIONS)
          throw bad(`查询条件最多 ${MAX_CONDITIONS} 个`);
        const c = item as QueryCondition;
        if (!c || typeof c.field !== 'string' || !OPS.has(c.op))
          throw bad('查询条件格式不对：要有 field 和白名单里的 op');
        const col = column(c.field);
        const v = c.value;
        const p = param();
        switch (c.op) {
          case 'isNull':
            add(`${col} IS NULL`);
            break;
          case 'notNull':
            add(`${col} IS NOT NULL`);
            break;
          case 'in':
          case 'notIn': {
            if (
              !Array.isArray(v) ||
              v.length === 0 ||
              v.length > MAX_IN ||
              !v.every(isScalar)
            )
              throw bad(`${c.op} 的值必须是 1 到 ${MAX_IN} 个简单值`);
            add(`${col} ${c.op === 'in' ? 'IN' : 'NOT IN'} (:...${p})`, {
              [p]: v,
            });
            break;
          }
          case 'between': {
            if (!Array.isArray(v) || v.length !== 2 || !v.every(isScalar))
              throw bad('between 的值必须是 [下限, 上限]');
            const q = param();
            add(`${col} BETWEEN :${p} AND :${q}`, { [p]: v[0], [q]: v[1] });
            break;
          }
          case 'contains':
          case 'startsWith': {
            if (typeof v !== 'string' || !v || v.length > 100)
              throw bad(`${c.op} 的值必须是 1 到 100 个字的文字`);
            const pattern =
              c.op === 'contains' ? `%${escapeLike(v)}%` : `${escapeLike(v)}%`;
            add(`${col} LIKE :${p}`, { [p]: pattern });
            break;
          }
          default: {
            if (!isScalar(v)) throw bad(`${c.op} 的值必须是简单值`);
            const sql = {
              eq: '=',
              ne: '<>',
              gt: '>',
              gte: '>=',
              lt: '<',
              lte: '<=',
            }[c.op as 'eq'];
            add(`${col} ${sql} :${p}`, { [p]: v });
          }
        }
      }
    });
  };
  qb.andWhere(group(where, 1));
}
