import { Injectable, Logger } from '@nestjs/common';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import { NodeEnv } from '../../../core/config/env.validation.js';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { APP_VERSION } from '../../../app.version.js';
import type { CodeBinding, CodeRule } from '../entity/code-rule.entity.js';
import { compatible, type CodeUsage } from './rule-config.js';

const describe = (usage: CodeUsage) => ({
  key: usage.key,
  name: usage.name,
  resource: usage.resource,
  field: usage.field,
  maxLength: usage.maxLength,
  minLength: usage.minLength ?? 1,
  charset: usage.charset,
  uniqueScope: usage.uniqueScope,
  allowRuleSwitch: usage.allowRuleSwitch,
});
type Description = ReturnType<typeof describe>;
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 仅输出白名单元数据；日志不会改变绑定、计数器或规则状态。 */
@Injectable()
export class CodeUsageDiagnostics {
  private readonly logger = new Logger('CodeUsageDiagnostics');
  private readonly checked = new Map<string, string>();
  private readonly known = new Map<string, Description>();
  constructor(private readonly config: AppConfigService) {}
  failure(
    reason: string,
    error: unknown,
    target: {
      key?: string;
      resource?: string;
      field?: string;
      tenantId?: string;
    } = {},
  ) {
    const detail =
      error instanceof BusinessException
        ? error.message
        : '检查未完成，请查看相邻启动或请求错误';
    const errors =
      error instanceof BusinessException
        ? (
            error.details as
              { errors?: { field?: string; messages?: string[] }[] } | undefined
          )?.errors
        : undefined;
    this.logger.error({
      event: 'code_usage.check_failed',
      version: APP_VERSION,
      reason,
      ...target,
      detail,
      fieldErrors: errors?.map((item) => ({
        field: item.field,
        messages: item.messages,
      })),
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  startup(
    phase: 'started' | 'finished',
    tenants: number,
    failed: number,
    elapsedMs: number,
  ) {
    this.logger.log({
      event: 'code_usage.startup_audit',
      version: APP_VERSION,
      phase,
      tenants,
      checkFailures: failed,
      elapsedMs,
    });
  }
  rolledBack(reason: string, tenantId?: string) {
    this.logger.warn({
      event: 'code_usage.change_rolled_back',
      version: APP_VERSION,
      tenantId,
      reason,
      detail: '事务已回滚，本次修改没有生效',
    });
  }
  invalid(
    target: { key?: string; resource?: string; field?: string },
    detail: string,
  ) {
    this.logger.error({
      event: 'code_usage.registration_failed',
      version: APP_VERSION,
      ...target,
      detail,
    });
  }
  definitions(usages: CodeUsage[]) {
    const start = Date.now();
    const current = usages
      .map(describe)
      .sort((a, b) => a.key.localeCompare(b.key));
    const file = join(process.cwd(), 'logs', 'code-usage-manifest.json');
    let previous: Description[] = [];
    if (this.config.nodeEnv === NodeEnv.Development) {
      try {
        if (statSync(file).size > 1024 * 1024)
          throw new Error('ManifestTooLarge');
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (
          !Array.isArray(parsed) ||
          parsed.length > 10000 ||
          !parsed.every(
            (item) =>
              item &&
              typeof item === 'object' &&
              typeof (item as Description).key === 'string' &&
              typeof (item as Description).resource === 'string' &&
              typeof (item as Description).field === 'string',
          )
        )
          throw new Error('InvalidManifest');
        previous = parsed as Description[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          this.failure('读取开发目录快照失败，无法判断本轮消失项', error);
      }
    }
    for (const item of [...previous, ...current])
      this.known.set(item.key, item);
    const old = new Map(previous.map((item) => [item.key, item]));
    let added = 0,
      changed = 0,
      missing = 0;
    for (const item of current) {
      const before = old.get(item.key);
      const status = !before
        ? 'added'
        : digest(before) === digest(item)
          ? 'unchanged'
          : 'changed';
      if (status === 'added') added++;
      else if (status === 'changed') changed++;
      const { name: usageName, ...definition } = item;
      this.logger.log({
        event: 'code_usage.registered',
        version: APP_VERSION,
        status,
        ...definition,
        usageName,
        detail:
          status === 'added'
            ? '编码字段已登记'
            : status === 'changed'
              ? '编码字段声明有变更'
              : '编码字段声明有效',
      });
    }
    for (const item of previous.filter(
      (item) => !current.some((next) => next.key === item.key),
    )) {
      missing++;
      this.logger.warn({
        event: 'code_usage.declaration_missing',
        version: APP_VERSION,
        key: item.key,
        resource: item.resource,
        field: item.field,
        detail:
          '本版本缺少上次的字段声明，请核对是否误删或已下线；未自动停用或删除数据库绑定',
      });
    }
    this.logger.log({
      event: 'code_usage.catalog_checked',
      version: APP_VERSION,
      scope: 'code',
      total: current.length,
      added,
      changed,
      missing,
      manifestHash: digest(current),
      elapsedMs: Date.now() - start,
    });
    if (this.config.nodeEnv === NodeEnv.Development) {
      try {
        mkdirSync(join(process.cwd(), 'logs'), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(current, null, 2));
        renameSync(temporary, file);
      } catch (error) {
        this.failure('保存开发目录诊断快照失败', error);
      }
    }
  }
  bindings(
    tenantId: string,
    reason: string,
    usages: CodeUsage[],
    bindings: CodeBinding[],
    rules: CodeRule[],
    force = false,
  ) {
    const start = Date.now();
    const catalog = new Map(usages.map((usage) => [usage.key, usage]));
    const byRule = new Map(rules.map((rule) => [rule.id, rule]));
    const bound = new Map(
      bindings.map((binding) => [binding.usageKey, binding]),
    );
    const entries = [...new Set([...catalog.keys(), ...bound.keys()])]
      .sort()
      .map((key) => {
        const usage = catalog.get(key),
          binding = bound.get(key),
          rule = binding ? byRule.get(binding.ruleId) : undefined;
        let status = 'ready',
          detail = '字段与绑定规则有效';
        if (!usage) {
          status = 'target_missing';
          detail =
            '绑定目标声明已缺失，无法继续通过该用途发号，请核对模块/表单；未修改绑定';
        } else if (!binding) {
          status = 'unbound';
          detail = '编码字段尚未绑定规则，业务保存时会被拒绝';
        } else if (!rule) {
          status = 'rule_missing';
          detail = '绑定规则不存在或已删除';
        } else if (rule.status !== '1') {
          status = 'rule_disabled';
          detail = '绑定规则已停用，当前不能发号';
        } else {
          try {
            compatible(rule, usage);
          } catch (error) {
            status = 'incompatible';
            const errors =
              error instanceof BusinessException
                ? (
                    error.details as
                      { errors?: { messages?: string[] }[] } | undefined
                  )?.errors
                : undefined;
            detail =
              errors?.flatMap((item) => item.messages ?? []).join('；') ||
              '规则与字段长度、字符集或格式不兼容';
          }
        }
        const target = usage ? describe(usage) : this.known.get(key);
        return {
          key,
          resource: target?.resource,
          field: target?.field,
          usageName: target?.name,
          ruleId: binding?.ruleId ?? null,
          status,
          detail,
        };
      });
    const signature = digest({
      usages: usages.map(describe).sort((a, b) => a.key.localeCompare(b.key)),
      entries,
    });
    if (!force && this.checked.get(tenantId) === signature) return;
    if (this.checked.size >= 100 && !this.checked.has(tenantId))
      this.checked.delete(this.checked.keys().next().value!);
    this.checked.set(tenantId, signature);
    const counts: Record<string, number> = {};
    for (const entry of entries) {
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
      const event = {
        event: 'code_usage.binding_checked',
        version: APP_VERSION,
        tenantId,
        reason,
        ...entry,
      };
      if (entry.status === 'ready') this.logger.log(event);
      else if (entry.status === 'unbound' || entry.status === 'rule_disabled')
        this.logger.warn(event);
      else this.logger.error(event);
    }
    this.logger.log({
      event: 'code_usage.bindings_summary',
      version: APP_VERSION,
      tenantId,
      reason,
      total: entries.length,
      counts,
      elapsedMs: Date.now() - start,
    });
  }
}
