import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import {
  DataSource,
  EntityManager,
  QueryRunner,
  EntitySubscriberInterface,
} from 'typeorm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BaseService } from '../../../core/crud/base.service.js';
import type { CrudTx } from '../../../core/crud/crud.types.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import {
  CodeRule,
  CodeBinding,
  CodeAllocation,
  CodeSequence,
  CodeRuleVersion,
} from '../entity/code-rule.entity.js';
import { CodeUsageRegistry } from './usage-registry.js';
import { CodeSequenceStore } from './code-sequence.store.js';
import { canonicalTimeZone } from '../../../core/time/time-zones.js';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../core/exceptions/error-code.js';
import {
  validateConfig,
  compatible,
  maximum,
  periodKey,
  renderCode,
  invalid,
  validateOutput,
} from './rule-config.js';

function conflict(message: string): never {
  throw new BusinessException(ErrorCode.Conflict, message, 409);
}
function databaseFailure(error: unknown): never {
  const code = (error as { driverError?: { code?: string } })?.driverError
    ?.code;
  if (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT')
    conflict('操作发生并发冲突，请使用原请求重试');
  if (code === 'ER_DUP_ENTRY')
    conflict('编码、用途绑定或规则已存在，请刷新检查');
  throw error;
}
@Injectable()
export class CodeRuleService
  extends BaseService<CodeRule>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly writeRules = new AsyncLocalStorage<boolean>();
  private readonly called = new WeakSet<QueryRunner>();
  private readonly subscriber: EntitySubscriberInterface = {
    afterTransactionCommit: (e) => {
      this.called.delete(e.queryRunner);
    },
    afterTransactionRollback: (e) => {
      this.called.delete(e.queryRunner);
    },
  };
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
    private readonly db: DataSource,
    readonly usages: CodeUsageRegistry,
    private readonly sequences: CodeSequenceStore,
  ) {
    super();
  }
  onModuleInit() {
    this.db.subscribers.push(this.subscriber);
  }
  onModuleDestroy() {
    const i = this.db.subscribers.indexOf(this.subscriber);
    if (i >= 0) this.db.subscribers.splice(i, 1);
  }
  override update(...args: Parameters<BaseService<CodeRule>['update']>) {
    return this.writeRules.run(true, () => super.update(...args));
  }
  override delete(...args: Parameters<BaseService<CodeRule>['delete']>) {
    return this.writeRules.run(true, () => super.delete(...args));
  }
  protected override transaction<R>(fn: (tx: CrudTx) => Promise<R>) {
    return super
      .transaction(async (tx) => {
        // 管理写操作先锁本租户的绑定，避免基类先锁规则形成反向锁序。
        if (this.writeRules.getStore())
          await this.repos
            .for(CodeBinding)
            .query('b', tx.manager)
            .orderBy('b.usageKey', 'ASC')
            .setLock('pessimistic_write')
            .getMany();
        return fn(tx);
      })
      .catch(databaseFailure);
  }
  protected override async beforeAdd(data: Partial<CodeRule>) {
    try {
      data.timezone = canonicalTimeZone(data.timezone!);
    } catch {
      invalid('请选择有效的系统时区', 'timezone');
    }
    Object.assign(data, validateConfig(data as CodeRule), {
      revision: 1,
      firstBoundAt: null,
      firstBoundUsageKey: null,
    });
  }
  protected override async afterAdd(row: CodeRule, tx: CrudTx) {
    await this.snapshot(row, tx.manager);
  }
  protected override async beforeUpdate(
    changes: Partial<CodeRule>,
    existing: CodeRule,
    tx: CrudTx,
  ) {
    const next = Object.assign(new CodeRule(), existing, changes);
    const behaviorChanged = [
      'segments',
      'resetPeriod',
      'timezone',
      'start',
    ].some(
      (k) =>
        JSON.stringify(next[k as keyof CodeRule]) !==
        JSON.stringify(existing[k as keyof CodeRule]),
    );
    if (
      changes.timezone !== undefined &&
      changes.timezone !== existing.timezone
    ) {
      try {
        next.timezone = canonicalTimeZone(changes.timezone);
        changes.timezone = next.timezone;
      } catch {
        invalid('请选择有效的系统时区', 'timezone');
      }
    }
    if (
      behaviorChanged ||
      (changes.status === 'enabled' && existing.status !== 'enabled')
    )
      validateConfig(next);
    const used = await this.repos
      .for(CodeAllocation)
      .query('a', tx.manager)
      .andWhere('a.ruleId = :id', { id: existing.id })
      .setLock('pessimistic_read')
      .getOne();
    if (used && behaviorChanged)
      conflict(
        '规则已发号，格式、时区、周期和起始值不可修改，请复制新规则并换绑',
      );
    const binding = await this.repos
      .for(CodeBinding)
      .query('b', tx.manager)
      .andWhere('b.ruleId = :id', { id: existing.id })
      .setLock('pessimistic_read')
      .getOne();
    if (binding && behaviorChanged)
      compatible(next, this.usages.get(binding.usageKey));
    changes.revision = existing.revision + 1;
  }
  protected override async afterUpdate(row: CodeRule, tx: CrudTx) {
    await this.snapshot(row, tx.manager);
  }
  protected override async beforeDelete(rows: CodeRule[], tx: CrudTx) {
    for (const row of rows) {
      if (
        row.firstBoundAt ||
        (await this.repos
          .for(CodeBinding)
          .query('b', tx.manager)
          .andWhere('b.ruleId = :id', { id: row.id })
          .setLock('pessimistic_read')
          .getOne()) ||
        (await this.repos
          .for(CodeAllocation)
          .query('a', tx.manager)
          .andWhere('a.ruleId = :id', { id: row.id })
          .setLock('pessimistic_read')
          .getOne())
      )
        conflict('规则曾绑定或已发号，不能删除，请停用');
    }
  }
  private snapshot(row: CodeRule, manager: EntityManager) {
    return this.repos.for(CodeRuleVersion).insert(
      {
        ruleId: row.id,
        revision: row.revision,
        snapshot: {
          code: row.code,
          name: row.name,
          description: row.description,
          timezone: row.timezone,
          resetPeriod: row.resetPeriod,
          segments: row.segments,
          start: row.start,
          status: row.status,
          // 保存规则自身的审计元数据；版本记录的系统字段属于版本行，不能当作规则版本号。
          id: row.id,
          createdBy: row.createdBy,
          createdAt: row.createdAt,
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt,
          orgId: row.orgId,
          version: row.version,
        },
      },
      manager,
    );
  }
  async usageList() {
    const bindings = await this.repos.for(CodeBinding).query('b').getMany();
    const rules = await this.repos.for(CodeRule).query('r').getMany();
    return this.usages.list().map((u) => {
      const b = bindings.find((b) => b.usageKey === u.key);
      const r = rules.find((r) => r.id === b?.ruleId);
      let issue = '';
      try {
        if (r) compatible(r, u);
      } catch {
        issue = '规则与当前用途约束不兼容';
      }
      return {
        ...u,
        ruleId: b?.ruleId ?? null,
        ruleName: r?.name ?? null,
        issue,
      };
    });
  }
  async bind(usageKey: string, ruleId: string) {
    if (!this.usages.list().some((u) => u.key === usageKey))
      invalid('请选择已注册的用途', 'usageKey');
    const usage = this.usages.get(usageKey);
    return this.transaction(async (tx) => {
      const repo = this.repos.for(CodeBinding);
      let binding = await repo
        .query('b', tx.manager)
        .andWhere('b.usageKey = :usageKey', { usageKey })
        .setLock('pessimistic_write')
        .getOne();
      if (binding?.ruleId === ruleId) return { usageKey, ruleId };
      if (binding && !usage.allowRuleSwitch) conflict('该用途不允许更换规则');
      const switching = Boolean(binding);
      if (!binding) {
        const id = await repo.insert({ usageKey, ruleId }, tx.manager);
        binding = await repo
          .query('b', tx.manager)
          .andWhere('b.id = :id', { id })
          .setLock('pessimistic_write')
          .getOne();
      }
      const rule = await this.repos
        .for(CodeRule)
        .query('r', tx.manager)
        .andWhere('r.id = :ruleId', { ruleId })
        .setLock('pessimistic_write')
        .getOne();
      if (!rule) throw crudErrors.notFound();
      if (rule.firstBoundAt || rule.status !== 'enabled')
        conflict('请选择从未绑定过且已启用的新规则');
      if (
        await this.repos
          .for(CodeAllocation)
          .query('a', tx.manager)
          .andWhere('a.ruleId = :ruleId', { ruleId })
          .setLock('pessimistic_read')
          .getOne()
      )
        conflict('规则已发号');
      if (
        await repo
          .query('b', tx.manager)
          .andWhere('b.ruleId = :ruleId AND b.id <> :id', {
            ruleId,
            id: binding!.id,
          })
          .setLock('pessimistic_read')
          .getOne()
      )
        conflict('规则已绑定其他用途');
      compatible(rule, usage);
      if (switching) {
        const first = rule.segments[0];
        if (first?.type !== 'literal')
          invalid('更换规则必须使用新的固定文本前缀');
        const prefix = first.value.replace(/[!%_]/g, (v) => `!${v}`);
        if (
          await this.repos
            .for(CodeAllocation)
            .query('a', tx.manager)
            .andWhere(
              "a.usageKey = :usageKey AND a.code LIKE :prefix ESCAPE '!'",
              { usageKey, prefix: `${prefix}%` },
            )
            .setLock('pessimistic_read')
            .getOne()
        )
          conflict('新前缀与历史编码冲突，请使用未占用的前缀');
        await repo.update([binding!.id], { ruleId }, tx.manager);
      }
      await this.repos
        .for(CodeRule)
        .update(
          [ruleId],
          { firstBoundAt: new Date(), firstBoundUsageKey: usageKey },
          tx.manager,
        );
      return { usageKey, ruleId };
    });
  }
  async preview(ruleId: string, usageKey?: string) {
    if (usageKey && !this.usages.list().some((u) => u.key === usageKey))
      invalid('请选择已注册的用途', 'usageKey');
    const rule = await this.select(this.crud.dataSource.manager, 'info')
      .andWhere('e.id = :ruleId', { ruleId })
      .getOne();
    if (!rule) throw crudErrors.notFound();
    validateConfig(rule);
    if (usageKey) compatible(rule, this.usages.get(usageKey));
    const now = new Date(),
      period = periodKey(rule, now);
    const seq = await this.repos
      .for(CodeSequence)
      .query('s')
      .andWhere('s.ruleId = :ruleId AND s.periodKey = :period', {
        ruleId,
        period,
      })
      .getOne();
    const start = seq ? BigInt(seq.current) + 1n : BigInt(rule.start);
    if (start > maximum(rule)) conflict('流水号已用尽，请新建规则并更换绑定');
    return {
      codes: Array.from({ length: 3 }, (_, i) => start + BigInt(i))
        .filter((n) => n <= maximum(rule))
        .map((n) => renderCode(rule, n, now)),
      periodKey: period,
      consumes: false,
    };
  }
  async versions(ruleId: string) {
    const visible = await this.info(ruleId);
    const states = (visible as Record<string, unknown>)._fieldState as
      Record<string, string> | undefined;
    const rows = await this.repos
      .for(CodeRuleVersion)
      .query('v')
      .andWhere('v.ruleId = :ruleId', { ruleId })
      .orderBy('v.revision', 'DESC')
      .take(100)
      .getMany();
    const result = rows.map((row) => {
      // 规则的编号、创建人/时间、归属组织不能通过此资源的更新接口修改。
      // 旧快照缺失时可从原规则恢复这些稳定属性，不能借用当前修改人或当前版本号。
      const historical: Record<string, unknown> = {
        ...Object.fromEntries(
          ['id', 'createdBy', 'createdAt', 'orgId']
            .filter((key) => Object.hasOwn(visible, key))
            .map((key) => [key, (visible as Record<string, unknown>)[key]]),
        ),
        // 版本行创建人是这次修订的操作人，创建时间是这次修订的保存时间。
        updatedBy: row.createdBy,
        updatedAt: row.createdAt,
        ...(row.revision === 1 ? { version: 1 } : {}),
        ...row.snapshot,
      };
      return {
        revision: row.revision,
        createdAt: row.createdAt,
        snapshot: Object.fromEntries(
          Object.entries(historical)
            .filter(
              ([key]) =>
                Object.hasOwn(visible, key) && states?.[key] !== 'hidden',
            )
            .map(([key, value]) => [
              key,
              states?.[key] === 'masked'
                ? (visible as Record<string, unknown>)[key]
                : value,
            ]),
        ),
      };
    });
    // 复用统一名称解析，历史操作人按历史编号显示，不能套用当前修改人的显示名。
    await this.withDisplay(result.map((entry) => entry.snapshot));
    return result;
  }

  async nextInTx(manager: EntityManager, usageKey: string) {
    return (await this.nextManyInTx(manager, [{ usageKey, count: 1 }]))[0]!;
  }
  async nextManyInTx(
    manager: EntityManager,
    requests: { usageKey: string; count: number }[],
  ) {
    try {
      return await this.allocate(manager, requests);
    } catch (error) {
      return databaseFailure(error);
    }
  }
  private async allocate(
    manager: EntityManager,
    requests: { usageKey: string; count: number }[],
  ) {
    const runner = manager.queryRunner;
    if (!runner?.isTransactionActive)
      throw new Error('编码生成必须在业务事务内执行');
    if (this.called.has(runner)) throw new Error('CODE_RULE_MULTIPLE_CALLS');
    if (
      !requests.length ||
      requests.length > 20 ||
      new Set(requests.map((r) => r.usageKey)).size !== requests.length ||
      requests.some(
        (r) => !Number.isInteger(r.count) || r.count < 1 || r.count > 100,
      ) ||
      requests.reduce((n, r) => n + r.count, 0) > 500
    )
      invalid('每用途1至100个，总量不超过500，且用途不能重复');
    const ctx = this.context.current();
    if (ctx.ignoreTenant) throw new Error('跨租户模式禁止发号');
    this.called.add(runner);
    const sorted = [...requests].sort((a, b) =>
      a.usageKey.localeCompare(b.usageKey),
    );
    const bound: { usageKey: string; count: number; ruleId: string }[] = [];
    for (const req of sorted) {
      this.usages.get(req.usageKey);
      const b = await this.repos
        .for(CodeBinding)
        .query('b', manager)
        .andWhere('b.usageKey = :key', { key: req.usageKey })
        .setLock('pessimistic_read')
        .getOne();
      if (!b) conflict('该用途尚未绑定编码规则，请联系管理员');
      bound.push({ ...req, ruleId: b.ruleId });
    }
    const now = new Date(),
      rules = new Map<string, CodeRule>();
    for (const item of [...bound].sort((a, b) =>
      BigInt(a.ruleId) < BigInt(b.ruleId) ? -1 : 1,
    )) {
      const r = await this.repos
        .for(CodeRule)
        .query('r', manager)
        .andWhere('r.id = :id', { id: item.ruleId })
        .setLock('pessimistic_read')
        .getOne();
      if (!r || r.status !== 'enabled')
        conflict('编码规则已停用，请联系管理员');
      compatible(r, this.usages.get(item.usageKey));
      rules.set(r.id, r);
    }
    const result = new Map<string, { usageKey: string; codes: string[] }>();
    for (const req of [...bound].sort((a, b) =>
      BigInt(a.ruleId) < BigInt(b.ruleId) ? -1 : 1,
    )) {
      const rule = rules.get(req.ruleId)!,
        period = periodKey(rule, now);
      const seq = await this.sequences.take(
        manager,
        rule.id,
        period,
        rule.start,
        req.count,
      );
      const end = BigInt(seq!.current);
      if (end > maximum(rule)) conflict('流水号已用尽，请新建规则并更换绑定');
      const codes: string[] = [];
      for (let i = 0; i < req.count; i++) {
        const n = end - BigInt(req.count) + 1n + BigInt(i),
          code = renderCode(rule, n, now);
        validateOutput(code, this.usages.get(req.usageKey));
        await this.repos.for(CodeAllocation).insert(
          {
            usageKey: req.usageKey,
            ruleId: rule.id,
            ruleRevision: rule.revision,
            code,
            sequenceValue: n.toString(),
            periodKey: period,
          },
          manager,
        );
        codes.push(code);
      }
      await this.repos
        .for(CodeSequence)
        .update([seq!.id], { lastCode: codes.at(-1)! }, manager);
      result.set(req.usageKey, { usageKey: req.usageKey, codes });
    }
    return requests.map((r) => result.get(r.usageKey)!);
  }
}
@Injectable()
export class CodeSequenceService extends BaseService<CodeSequence> {}
