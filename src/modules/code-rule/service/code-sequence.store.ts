import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { CodeSequence } from '../entity/code-rule.entity.js';

/** 经确认的计数器原子写边界；只访问计数器，身份始终取框架上下文。 */
@Injectable()
export class CodeSequenceStore {
  constructor(
    private readonly context: RequestContext,
    private readonly repos: TenantRepositoryFactory,
  ) {}
  async take(
    manager: EntityManager,
    ruleId: string,
    period: string,
    start: string,
    count: number,
  ) {
    const ctx = this.context.current();
    if (ctx.ignoreTenant || !manager.queryRunner?.isTransactionActive)
      throw new Error('计数器必须在本租户业务事务内写入');
    await manager.query(
      'INSERT INTO sys_code_sequence (tenant_id,org_id,created_by,updated_by,rule_id,period_key,current,last_code,version) VALUES (?,?,?,?,?,?,?,NULL,1) ON DUPLICATE KEY UPDATE current = current + ?',
      [
        ctx.tenantId,
        ctx.orgId,
        ctx.userId,
        ctx.userId,
        ruleId,
        period,
        (BigInt(start) + BigInt(count) - 1n).toString(),
        count,
      ],
    );
    const sequence = await this.repos
      .for(CodeSequence)
      .query('s', manager)
      .andWhere('s.ruleId = :id AND s.periodKey = :period', {
        id: ruleId,
        period,
      })
      .setLock('pessimistic_write')
      .getOne();
    if (!sequence) throw new Error('计数器写入后不存在');
    return sequence;
  }
}
