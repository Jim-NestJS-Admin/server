import {
  Inject,
  Injectable,
  OnModuleInit,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { CodeUsageDiagnostics } from './usage-diagnostics.js';
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
    private readonly diagnostics: CodeUsageDiagnostics,
  ) {
    let failures = 0;
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
      ) {
        this.diagnostics.invalid(
          { key: u.key, resource: u.resource, field: u.field },
          '编码用途注册重复或约束无效',
        );
        failures++;
        continue;
      }
      this.entries.set(u.key, Object.freeze({ ...u }));
    }
    if (failures)
      throw new Error(
        `编码用途登记失败，共${failures}项，详见registration_failed日志`,
      );
  }
  onModuleInit() {
    if (this.config.openApiExport) return;
    const failures: string[] = [];
    for (const u of this.entries.values())
      if (u.entity) {
        const column = this.db.hasMetadata(u.entity)
          ? this.db.getMetadata(u.entity).findColumnWithPropertyName(u.field)
          : undefined;
        if (
          !column ||
          !['varchar', 'char'].includes(String(column.type)) ||
          Number(column.length) < u.maxLength
        ) {
          this.diagnostics.invalid(
            { key: u.key, resource: u.resource, field: u.field },
            '声明字段不存在或列长度不兼容',
          );
          failures.push(u.key);
        }
      }
    if (failures.length)
      throw new Error(
        `编码字段登记失败：${failures.join('、')}，详见registration_failed日志`,
      );
  }
  onApplicationBootstrap() {
    if (!this.config.openApiExport)
      this.diagnostics.definitions([...this.list(), ...this.crudUsages()]);
  }
  addSource(
    name: string,
    source: (manager?: EntityManager) => Promise<CodeUsage[]>,
  ) {
    if (this.sources.has(name)) throw new Error('编码用途来源重复');
    this.sources.set(name, source);
  }
  private crudUsages(): CodeUsage[] {
    const failures: string[] = [];
    const usages: CodeUsage[] = this.runtime.list().flatMap((r) =>
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
          .flatMap((f): CodeUsage[] => {
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
              !Number.isInteger(length) ||
              length < 1 ||
              length > 64 ||
              !unique ||
              !Number.isInteger(f.code!.minLength ?? 1) ||
              (f.code!.minLength ?? 1) < 1 ||
              (f.code!.minLength ?? 1) > length
            ) {
              const detail =
                '自动编码字段必须为1至64位非空文本，并具有租户+字段+activeGuard唯一索引';
              this.diagnostics.invalid(
                {
                  key: fieldUsageKey('crud', r.resource, f.property),
                  resource: r.resource,
                  field: f.property,
                },
                detail,
              );
              failures.push(`${r.resource}.${f.property}${detail}`);
              return [];
            }
            return [
              {
                key: fieldUsageKey('crud', r.resource, f.property),
                name: `${r.label} / ${f.label}`,
                resource: r.resource,
                field: f.property,
                maxLength: length,
                minLength: f.code!.minLength ?? 1,
                charset: f.code!.charset,
                uniqueScope: 'tenant' as const,
                allowRuleSwitch: f.code!.allowRuleSwitch ?? true,
              },
            ];
          }),
      ),
    );
    if (failures.length)
      throw new Error(`编码字段登记失败：${failures.join('；')}`);
    return usages;
  }
  async catalog(manager?: EntityManager) {
    const entries = [
      ...this.list(),
      ...this.crudUsages(),
      ...(
        await Promise.all(
          [...this.sources.entries()].map(async ([name, source]) => {
            try {
              return await source(manager);
            } catch (error) {
              this.diagnostics.failure(`读取用途来源${name}失败`, error);
              throw error;
            }
          }),
        )
      ).flat(),
    ];
    if (new Set(entries.map((u) => u.key)).size !== entries.length) {
      const seen = new Set<string>();
      for (const u of entries) {
        if (seen.has(u.key))
          this.diagnostics.invalid(
            { key: u.key, resource: u.resource, field: u.field },
            '编码用途重复',
          );
        seen.add(u.key);
      }
      throw new Error('编码用途重复');
    }
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
