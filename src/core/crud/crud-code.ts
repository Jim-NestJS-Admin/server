import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { CrudFieldMeta } from './crud-field.decorator.js';

/** 字段声明是接入入口；模块配置只能绑定规则，不能将普通字段变成可自动写入字段。 */
export interface CrudCodeOptions {
  charset: 'upper_alnum' | 'lower_slug' | 'digits' | 'unrestricted';
  minLength?: number;
  allowRuleSwitch?: boolean;
}
export interface CrudCodeSource {
  nextManyInTx(
    manager: EntityManager,
    requests: { usageKey: string; count: number }[],
  ): Promise<{ usageKey: string; codes: string[] }[]>;
}
export const fieldUsageKey = (
  kind: 'crud' | 'form',
  resource: string,
  field: string,
) =>
  `${kind}_${createHash('sha256')
    .update(JSON.stringify([resource, field]))
    .digest('hex')
    .slice(0, 48)}`;
export interface CodeTarget {
  resource: string;
  fields: CrudFieldMeta[];
  rows: Record<string, unknown>[];
}
export async function fillCodeFields(
  source: CrudCodeSource | undefined,
  manager: EntityManager,
  targets: CodeTarget[],
) {
  const jobs = targets
    .flatMap((target) =>
      target.fields
        .filter((field) => field.code)
        .map((field) => ({
          key: fieldUsageKey('crud', target.resource, field.property),
          field: field.property,
          rows: target.rows,
        })),
    )
    .filter((job) => job.rows.length);
  if (!jobs.length) return;
  if (!source) throw new Error('自动编码字段尚未装配编码规则服务');
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const job of jobs)
    groups.set(job.key, [...(groups.get(job.key) ?? []), ...job.rows]);
  const results = await source.nextManyInTx(
    manager,
    [...groups].map(([usageKey, rows]) => ({ usageKey, count: rows.length })),
  );
  for (const result of results) {
    const job = jobs.find((item) => item.key === result.usageKey)!;
    groups.get(result.usageKey)!.forEach((row, i) => {
      row[job.field] = result.codes[i]!;
    });
  }
}
