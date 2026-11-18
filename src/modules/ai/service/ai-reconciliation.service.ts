import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BaseService } from '../../../core/crud/base.service.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { IdempotencyLedger } from '../../../core/security/idempotency.ledger.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import {
  AiMonthlyUsage,
  AiTask,
  AiReconciliation,
} from '../entity/ai.entity.js';
import type { AiReconcileBody } from '../dto/ai.dto.js';
@Injectable()
export class AiReconciliationService extends BaseService<AiReconciliation> {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly ledger: IdempotencyLedger,
    private readonly db: DataSource,
  ) {
    super();
  }
  async uncertain() {
    const rows = await this.repos
      .for(AiTask)
      .query('t')
      .select([
        't.id',
        't.version',
        't.model',
        't.reservedTokens',
        't.createdAt',
      ])
      .andWhere('t.status=:status', { status: 'uncertain' })
      .orderBy('t.id', 'ASC')
      .take(100)
      .getMany();
    return {
      list: rows.map((row) => ({
        id: row.id,
        version: row.version,
        model: row.model,
        reservedTokens: row.reservedTokens,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
  async reconcile(body: AiReconcileBody) {
    if (!body.charged && (body.inputTokens || body.outputTokens))
      throw crudErrors.badRequest('未计费时Token必须为0');
    const original = await this.repos
      .for(AiTask)
      .query('t', this.db.manager)
      .andWhere('t.id=:id', { id: body.id })
      .getOne();
    if (!original) throw crudErrors.notFound();
    return this.ledger.transaction(async (manager) => {
      const usage = await this.repos
        .for(AiMonthlyUsage)
        .query('m', manager)
        .andWhere('m.month=:month', { month: original.month })
        .setLock('pessimistic_write')
        .getOneOrFail();
      const task = await this.repos
        .for(AiTask)
        .query('t', manager)
        .andWhere('t.id=:id', { id: body.id })
        .setLock('pessimistic_write')
        .getOne();
      if (!task) throw crudErrors.notFound();
      if (task.status !== 'uncertain' || task.version !== body.version)
        throw crudErrors.versionConflict();
      const used = BigInt(body.inputTokens) + BigInt(body.outputTokens);
      await this.repos.for(AiMonthlyUsage).update(
        [usage.id],
        {
          reservedTokens: (
            BigInt(usage.reservedTokens) - BigInt(task.reservedTokens)
          ).toString(),
          usedTokens: (BigInt(usage.usedTokens) + used).toString(),
        },
        manager,
      );
      await this.repos.for(AiTask).update(
        [task.id],
        {
          status: 'failed',
          reservedTokens: '0',
          inputTokens: body.inputTokens,
          outputTokens: body.outputTokens,
          error: body.charged
            ? '账单已核对并结算；生成结果未确认'
            : '账单已核对未计费；已释放预占',
        },
        manager,
      );
      return {
        id: await this.repos.for(AiReconciliation).insert(
          {
            taskId: task.id,
            charged: body.charged,
            inputTokens: body.inputTokens,
            outputTokens: body.outputTokens,
            evidence: body.evidence,
          },
          manager,
        ),
      };
    });
  }
}
