import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { BaseService } from '../../../core/crud/base.service.js';
import type { CrudAction } from '../../../core/crud/crud.types.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { IdempotencyLedger } from '../../../core/security/idempotency.ledger.js';
import { PermissionService } from '../../../core/permission/permission.service.js';
import { TenantQuotaService } from '../../tenant/service/tenant-quota.service.js';
import { SystemDirectory } from '../../system/service/system-directory.service.js';
import { AiMonthlyUsage, AiTask, type AiStatus } from '../entity/ai.entity.js';
import type {
  AiSubmitBody,
  AiTaskResult,
  AiUsageResult,
} from '../dto/ai.dto.js';
import { AiSettingsService, AiTemplateService } from './ai-settings.service.js';
import { AiCrypto } from './ai-crypto.js';
import { AiProvider, AiProviderFailure } from './ai-provider.js';
import { renderTemplate } from './ai-template.js';

/** 唯一模型调用入口；模型返回只保存在加密草稿，不触发任何业务发布。 */
@Injectable()
export class AiService extends BaseService<AiTask> {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
    private readonly db: DataSource,
    private readonly ledger: IdempotencyLedger,
    private readonly quota: TenantQuotaService,
    private readonly settings: AiSettingsService,
    private readonly templates: AiTemplateService,
    private readonly crypto: AiCrypto,
    private readonly provider: AiProvider,
    private readonly permissions: PermissionService,
    private readonly directory: SystemDirectory,
  ) {
    super();
  }
  protected override select(manager: EntityManager, action: CrudAction) {
    const ctx = this.context.current();
    return super
      .select(manager, action)
      .andWhere('e.ownerId = :owner', { owner: ctx.userId })
      .andWhere(
        ctx.orgId ? 'e.orgId = :org' : 'e.orgId IS NULL',
        ctx.orgId ? { org: ctx.orgId } : {},
      );
  }
  private async monthly(month: string, manager: EntityManager) {
    let row = await this.repos
      .for(AiMonthlyUsage)
      .query('m', manager)
      .andWhere('m.month = :month', { month })
      .setLock('pessimistic_write')
      .getOne();
    if (!row) {
      const id = await this.repos
        .for(AiMonthlyUsage)
        .insert({ month, usedTokens: '0', reservedTokens: '0' }, manager);
      row = await this.repos
        .for(AiMonthlyUsage)
        .query('m', manager)
        .andWhere('m.id = :id', { id })
        .setLock('pessimistic_write')
        .getOneOrFail();
    }
    return row;
  }
  async submit(body: AiSubmitBody) {
    return this.ledger.transaction(async (manager) => ({
      id: await this.create(body, manager),
    }));
  }
  async submitBatch(items: AiSubmitBody[]) {
    return this.ledger.transaction(async (manager) => {
      const ids: string[] = [];
      for (const body of items) ids.push(await this.create(body, manager));
      return { ids };
    });
  }
  private async create(body: AiSubmitBody, manager: EntityManager) {
    if (this.context.current().tenantId === '0')
      throw crudErrors.badRequest('请切换到业务租户使用AI');
    const credentials = await this.settings.credentials();
    if (body.feature === 'translate' && !body.language?.trim())
      throw crudErrors.badRequest('翻译必须指定目标语言');
    const limit = await this.quota.aiTokenLimit(
      this.context.current().tenantId,
      manager,
    );
    const active = await this.repos
      .for(AiTask)
      .query('t', manager)
      .andWhere('t.status IN (:...statuses)', {
        statuses: ['queued', 'running'],
      })
      .getCount();
    if (active >= 50)
      throw crudErrors.badRequest('本租户已有50个AI任务排队，请稍后再试');
    const template = await this.templates.resolve(body.feature, manager);
    const prompt = renderTemplate(template.content, {
      text: body.text,
      instruction: body.instruction ?? '',
      language: body.language ?? '',
    });
    if (Buffer.byteLength(prompt) > 96000)
      throw crudErrors.badRequest('提示词过长');
    const month = new Date().toISOString().slice(0, 7),
      usage = await this.monthly(month, manager);
    // UTF-8字节数作保守初始预占；发出生成请求前再按提供方计数和余量调整。
    const reserve = BigInt(
      Buffer.byteLength(prompt) + credentials.maxOutputTokens + 1024,
    );
    this.assertBudget(usage, reserve, limit);
    await this.repos.for(AiMonthlyUsage).update(
      [usage.id],
      {
        reservedTokens: (BigInt(usage.reservedTokens) + reserve).toString(),
      },
      manager,
    );
    const id = await this.repos.for(AiTask).insert(
      {
        ownerId: this.context.current().userId!,
        feature: body.feature,
        status: 'queued',
        model: credentials.model,
        templateRevision: template.revision,
        month,
        reservedTokens: reserve.toString(),
        maxOutputTokens: credentials.maxOutputTokens,
        requestCipher: this.crypto.encrypt(prompt, 'request'),
        resultCipher: null,
        claimToken: null,
        leaseUntil: null,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        error: '',
      },
      manager,
    );
    // 幂等账本只保存任务编号，不保存正文/结果/密钥。
    return id;
  }
  private assertBudget(
    usage: AiMonthlyUsage,
    extra: bigint,
    limit: number | null,
  ) {
    if (
      limit !== null &&
      BigInt(usage.usedTokens) + BigInt(usage.reservedTokens) + extra >
        BigInt(limit)
    )
      throw crudErrors.badRequest(
        '本月AI Token配额不足（含处理中及结果不确定的预占）',
      );
  }
  async usage(): Promise<AiUsageResult> {
    return this.db.transaction(async (manager) => {
      const limit = await this.quota.aiTokenLimit(
          this.context.current().tenantId,
          manager,
        ),
        month = new Date().toISOString().slice(0, 7);
      const row = await this.repos
        .for(AiMonthlyUsage)
        .query('m', manager)
        .andWhere('m.month = :month', { month })
        .getOne();
      return {
        month,
        limit,
        usedTokens: row?.usedTokens ?? '0',
        reservedTokens: row?.reservedTokens ?? '0',
      };
    });
  }
  async result(id: string): Promise<AiTaskResult> {
    const row = await this.select(this.db.manager, 'info')
      .addSelect('e.resultCipher')
      .andWhere('e.id = :id', { id })
      .getOne();
    if (!row) throw crudErrors.notFound();
    return {
      id: row.id,
      status: row.status,
      error: row.error,
      text: row.resultCipher
        ? this.crypto.decrypt(row.resultCipher, 'result')
        : '',
    };
  }
  /** 由租户后台worker调用。崩溃租约只转uncertain，不重复发出生成请求。 */
  async queued() {
    return this.repos
      .for(AiTask)
      .query('t')
      .select(['t.id'])
      .andWhere('t.status = :status', { status: 'queued' })
      .orderBy('t.id', 'ASC')
      .take(50)
      .getMany();
  }
  async hasWork() {
    return (
      (await this.repos
        .for(AiTask)
        .query('t')
        .andWhere('t.status IN (:...statuses)', {
          statuses: ['queued', 'running'],
        })
        .getCount()) > 0
    );
  }
  async runPending(taskId?: string) {
    const task = await this.db.transaction(async (manager) => {
      await this.quota.aiTokenLimit(this.context.current().tenantId, manager);
      const stale = await this.repos
        .for(AiTask)
        .query('t', manager)
        .andWhere('t.status = :status AND t.leaseUntil < :now', {
          status: 'running',
          now: new Date(),
        })
        .setLock('pessimistic_write')
        .getMany();
      for (const item of stale)
        await this.repos.for(AiTask).update(
          [item.id],
          {
            status: 'uncertain',
            error: '执行中断，费用待核对，预占保留',
            requestCipher: null,
          },
          manager,
        );
      if (
        await this.repos
          .for(AiTask)
          .query('t', manager)
          .andWhere('t.status = :status', { status: 'running' })
          .getCount()
      )
        return null;
      const query = this.repos
        .for(AiTask)
        .query('t', manager)
        .addSelect('t.requestCipher')
        .andWhere('t.status = :status', { status: 'queued' })
        .orderBy('t.id', 'ASC')
        .setLock('pessimistic_write');
      if (taskId) query.andWhere('t.id = :id', { id: taskId });
      const row = await query.getOne();
      if (!row) return null;
      row.claimToken = randomUUID();
      await this.repos.for(AiTask).update(
        [row.id],
        {
          status: 'running',
          claimToken: row.claimToken,
          leaseUntil: new Date(Date.now() + 300000),
        },
        manager,
      );
      return row;
    });
    if (!task) return;
    const start = Date.now();
    let sent = false;
    try {
      const input = await this.context.run(
        {
          tenantId: this.context.current().tenantId,
          userId: task.ownerId,
          orgId: task.orgId,
        },
        async () => {
          const identity = await this.directory.notificationIdentity(
            task.ownerId,
          );
          if (!identity) throw crudErrors.badRequest('调用账号不可用');
          await this.permissions.authorize('ai:task:add');
          return {
            ...(await this.settings.credentials()),
            model: task.model,
            maxOutputTokens: task.maxOutputTokens,
            prompt: this.crypto.decrypt(task.requestCipher!, 'request'),
          };
        },
      );
      const estimated = await this.provider.count(input);
      if (!Number.isSafeInteger(estimated) || estimated < 0)
        throw new Error('Token计数无效');
      // countTokens是估计值。额外余量预占；真实usage仍按提供方回执结算。
      const reserve = BigInt(estimated + input.maxOutputTokens + 1024);
      await this.db.transaction(async (manager) => {
        const limit = await this.quota.aiTokenLimit(
          this.context.current().tenantId,
          manager,
        );
        const usage = await this.monthly(task.month, manager),
          delta = reserve - BigInt(task.reservedTokens);
        const current = await this.repos
          .for(AiTask)
          .query('t', manager)
          .andWhere('t.id = :id', { id: task.id })
          .setLock('pessimistic_write')
          .getOne();
        if (
          !current ||
          current.status !== 'running' ||
          current.claimToken !== task.claimToken ||
          !current.leaseUntil ||
          current.leaseUntil.getTime() <= Date.now()
        )
          throw crudErrors.badRequest('AI任务租约已失效');
        this.assertBudget(usage, delta, limit);
        await this.repos.for(AiMonthlyUsage).update(
          [usage.id],
          {
            reservedTokens: (BigInt(usage.reservedTokens) + delta).toString(),
          },
          manager,
        );
        await this.repos
          .for(AiTask)
          .update([task.id], { reservedTokens: reserve.toString() }, manager);
      });
      task.reservedTokens = reserve.toString();
      // Token计数也可能耗时；在产生费用的生成请求前再次核对账号和动作权限。
      await this.context.run(
        {
          tenantId: this.context.current().tenantId,
          userId: task.ownerId,
          orgId: task.orgId,
        },
        async () => {
          if (!(await this.directory.notificationIdentity(task.ownerId)))
            throw crudErrors.badRequest('调用账号不可用');
          await this.permissions.authorize('ai:task:add');
        },
      );
      sent = true;
      let flushedAt = 0;
      const result = await this.provider.stream(input, async (text) => {
        if (Date.now() - flushedAt < 500) return;
        flushedAt = Date.now();
        await this.db.transaction(async (manager) => {
          const current = await this.repos
            .for(AiTask)
            .query('t', manager)
            .andWhere('t.id=:id', { id: task.id })
            .setLock('pessimistic_write')
            .getOne();
          if (
            current?.status !== 'running' ||
            current.claimToken !== task.claimToken
          )
            throw new Error('任务租约失效');
          await this.repos
            .for(AiTask)
            .update(
              [task.id],
              { resultCipher: this.crypto.encrypt(text, 'result') },
              manager,
            );
        });
      });
      if (
        !Number.isSafeInteger(result.inputTokens) ||
        !Number.isSafeInteger(result.outputTokens) ||
        result.inputTokens < 0 ||
        result.outputTokens < 0
      )
        throw new Error('Token回执无效');
      const resultCipher = this.crypto.encrypt(result.text, 'result');
      await this.finish(task, 'succeeded', '', Date.now() - start, {
        ...result,
        resultCipher,
      });
    } catch (error) {
      const uncertain =
        sent && !(error instanceof AiProviderFailure && error.definite);
      await this.finish(
        task,
        uncertain ? 'uncertain' : 'failed',
        uncertain
          ? '模型结果不确定，预占保留，请联系管理员核对'
          : '任务未完成，请检查配置、权限或套餐配额',
        Date.now() - start,
      );
    }
  }
  private async finish(
    task: AiTask,
    status: AiStatus,
    error: string,
    durationMs: number,
    result?: {
      inputTokens: number;
      outputTokens: number;
      resultCipher: string;
    },
  ) {
    await this.db.transaction(async (manager) => {
      // 结算只锁已有月用量→任务，不反向取租户锁；停用后仍须结算已发出的费用。
      const usage = await this.monthly(task.month, manager);
      const current = await this.repos
        .for(AiTask)
        .query('t', manager)
        .andWhere('t.id = :id', { id: task.id })
        .setLock('pessimistic_write')
        .getOne();
      if (
        !current ||
        current.status !== 'running' ||
        current.claimToken !== task.claimToken
      )
        return;
      const keep = status === 'uncertain',
        charged =
          BigInt(result?.inputTokens ?? 0) + BigInt(result?.outputTokens ?? 0);
      await this.repos.for(AiMonthlyUsage).update(
        [usage.id],
        {
          usedTokens: (BigInt(usage.usedTokens) + charged).toString(),
          reservedTokens: (
            BigInt(usage.reservedTokens) -
            (keep ? 0n : BigInt(current.reservedTokens))
          ).toString(),
        },
        manager,
      );
      await this.repos.for(AiTask).update(
        [task.id],
        {
          status,
          error,
          durationMs,
          requestCipher: null,
          resultCipher: result?.resultCipher ?? null,
          inputTokens: result?.inputTokens ?? 0,
          outputTokens: result?.outputTokens ?? 0,
          reservedTokens: keep ? current.reservedTokens : '0',
          leaseUntil: null,
        },
        manager,
      );
    });
  }
}
