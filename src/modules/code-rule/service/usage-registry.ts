import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import type { CodeUsage } from './rule-config.js';
export const CODE_USAGES = Symbol('code-usages');
@Injectable()
export class CodeUsageRegistry implements OnModuleInit {
  private readonly entries = new Map<string, CodeUsage>();
  constructor(
    @Inject(CODE_USAGES) usages: readonly CodeUsage[],
    private readonly db: DataSource,
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
  get(key: string) {
    const u = this.entries.get(key);
    if (!u) throw new Error('编码用途未在服务端注册');
    return u;
  }
  list() {
    return [...this.entries.values()];
  }
}
