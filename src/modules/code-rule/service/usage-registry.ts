import {
  Inject,
  Injectable,
  OnModuleInit,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { CrudRuntime } from '../../../core/crud/crud.runtime.js';
import { fieldUsageKey } from '../../../core/crud/crud-code.js';
import type { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import type { CodeUsage } from './rule-config.js';
export const CODE_USAGES = Symbol('code-usages');
@Injectable()
export class CodeUsageRegistry implements OnModuleInit, OnApplicationBootstrap {
  private readonly entries = new Map<string, CodeUsage>();
  private readonly sources = new Map<
    string,
    (manager?: EntityManager) => Promise<CodeUsage[]>
  >();
  constructor(
    @Inject(CODE_USAGES) usages: readonly CodeUsage[],
    private readonly db: DataSource,
    private readonly runtime: CrudRuntime,
    private readonly config: AppConfigService,
  ) {
    for (const u of usages) {
      if (
        !/^[a-z][a-z0-9_]{1,63}$/.test(u.key) ||
        this.entries.has(u.key) ||
        u.uniqueScope !== 'tenant' ||
        !['upper_alnum', 'lower_slug', 'digits'].includes(u.charset) ||
        !Number.isInteger(u.maxLength) ||
        u.maxLength < 1 ||
        u.maxLength > 64 ||
        (u.minLength ?? 1) < 1 ||
        (u.minLength ?? 1) > u.maxLength
      )
        throw new Error('编码用途注册重复或约束无效');
      this.entries.set(u.key, Object.freeze({ ...u }));
    }
  }
  onModuleInit() {
    if (this.config.openApiExport) return;
    for (const u of this.entries.values())
      if (u.entity) {
        const column = this.db
          .getMetadata(u.entity)
          .findColumnWithPropertyName(u.field);
        if (
          !column ||
          !['varchar', 'char'].includes(String(column.type)) ||
          Number(column.length) < u.maxLength
        )
          throw new Error(`编码用途${u.key}字段不存在或长度不兼容`);
      }
  }
  onApplicationBootstrap() {
    if (!this.config.openApiExport) this.crudUsages();
  }
  addSource(
    name: string,
    source: (manager?: EntityManager) => Promise<CodeUsage[]>,
  ) {
    if (this.sources.has(name)) throw new Error('编码用途来源重复');
    this.sources.set(name, source);
  }
  private crudUsages(): CodeUsage[] {
    return this.runtime.list().flatMap((r) =>
      [
        {
          resource: r.prefix,
          label: r.label,
          fields: r.api.includes('add') ? r.fields : [],
          entity: r.entity,
        },
        ...r.children.map((c) => ({
          resource: `${r.prefix}/${c.resource}`,
          label: `${r.label} / ${c.label}`,
          fields: c.fields,
          entity: c.entity,
        })),
      ].flatMap((r) =>
        r.fields
          .filter((f) => f.code)
          .map((f) => {
            const column = this.db
              .getMetadata(r.entity)
              .findColumnWithPropertyName(f.property);
            const length = Number(column?.length);
            const unique = this.db
              .getMetadata(r.entity)
              .indices.some(
                (i) =>
                  i.isUnique &&
                  i.columns.length === 3 &&
                  ['tenantId', f.property, 'activeGuard'].every((key) =>
                    i.columns.some((c) => c.propertyName === key),
                  ),
              );
            if (
              !column ||
              !['varchar', 'char'].includes(String(column.type)) ||
              column.isNullable ||
              length < 1 ||
              length > 64 ||
              !unique ||
              !Number.isInteger(f.code!.minLength ?? 1) ||
              (f.code!.minLength ?? 1) < 1 ||
              (f.code!.minLength ?? 1) > length
            )
              throw new Error(
                `${r.resource}.${f.property}自动编码字段必须为1至64位非空文本，并具有租户+字段+activeGuard唯一索引`,
              );
            return {
              key: fieldUsageKey('crud', r.resource, f.property),
              name: `${r.label} / ${f.label}`,
              resource: r.resource,
              field: f.property,
              maxLength: length,
              minLength: f.code!.minLength ?? 1,
              charset: f.code!.charset,
              uniqueScope: 'tenant' as const,
              allowRuleSwitch: f.code!.allowRuleSwitch ?? true,
            };
          }),
      ),
    );
  }
  async catalog(manager?: EntityManager) {
    const entries = [
      ...this.list(),
      ...this.crudUsages(),
      ...(
        await Promise.all(
          [...this.sources.values()].map((source) => source(manager)),
        )
      ).flat(),
    ];
    if (new Set(entries.map((u) => u.key)).size !== entries.length)
      throw new Error('编码用途重复');
    return entries;
  }
  async resolve(key: string, manager?: EntityManager) {
    const usage = (await this.catalog(manager)).find((u) => u.key === key);
    if (!usage)
      throw crudErrors.badRequest(
        '对应业务字段已移除或未登记自动编码，请核对模块配置',
      );
    return usage;
  }
  get(key: string) {
    const u = this.entries.get(key);
    if (!u) throw new Error('编码用途未在服务端注册');
    return u;
  }
  list() {
    return [...this.entries.values()];
  }
}
