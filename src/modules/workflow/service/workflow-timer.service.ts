import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { TenantSource } from '../../../core/tenant/tenant-source.js';
import { WorkflowTimer } from '../entity/workflow-timer.entity.js';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';

/** 认领租约与执行结果分开：租约可过期恢复，真正办理/记录/发件箱/完成标记同事务。 */
@Injectable()
export class WorkflowTimerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('WorkflowTimer');
  private interval?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly db: DataSource,
    private readonly config: AppConfigService,
    private readonly context: RequestContext,
    private readonly tenants: TenantSource,
    private readonly repos: TenantRepositoryFactory,
    private readonly runtime: WorkflowRuntimeService,
  ) {}
  onApplicationBootstrap() {
    if (this.config.openApiExport || this.config.nodeEnv === 'test') return;
    this.interval = setInterval(() => {
      if (!this.running && !this.stopping)
        this.running = this.scan()
          .catch(() =>
            this.logger.error({
              event: 'workflow.timer.scan_failed',
              detail: '定时器扫描失败，下轮重试；请检查数据库和租户目录',
            }),
          )
          .finally(() => {
            this.running = undefined;
          });
    }, 5000);
    this.interval.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    await this.running;
  }
  private async scan() {
    for (const tenantId of await this.tenants.activeTenantIds()) {
      if (this.stopping) break;
      if (!(await this.tenants.byId(tenantId))?.enabled) continue;
      await this.context.run({ tenantId }, async () => {
        const jobs = await this.db.transaction(async (manager) => {
          const now = new Date();
          const rows = await this.repos
            .for(WorkflowTimer)
            .query('r', manager)
            .andWhere(
              '((r.status = :pending AND r.dueAt <= :now AND (r.claimedUntil IS NULL OR r.claimedUntil <= :now)) OR (r.status = :claimed AND r.claimedUntil <= :now))',
              { pending: 'pending', claimed: 'claimed', now },
            )
            .orderBy('r.dueAt', 'ASC')
            .addOrderBy('r.id', 'ASC')
            .limit(10)
            .setLock('pessimistic_write')
            .setOnLocked('skip_locked')
            .getMany();
          const jobs: { id: string; token: string }[] = [];
          for (const row of rows) {
            const token = randomUUID();
            await this.repos.for(WorkflowTimer).update(
              [row.id],
              {
                status: 'claimed',
                claimToken: token,
                claimedUntil: new Date(Date.now() + 60000),
                attempts: row.attempts + 1,
              },
              manager,
            );
            jobs.push({ id: row.id, token });
          }
          return jobs;
        });
        for (const job of jobs) {
          if (this.stopping) break;
          try {
            await this.runtime.timeout(job.id, job.token);
          } catch {
            await this.db.transaction(async (manager) => {
              const row = await this.repos
                .for(WorkflowTimer)
                .query('r', manager)
                .andWhere('r.id = :id', { id: job.id })
                .setLock('pessimistic_write')
                .getOne();
              if (
                !row ||
                row.status !== 'claimed' ||
                row.claimToken !== job.token
              )
                return;
              await this.repos.for(WorkflowTimer).update(
                [row.id],
                {
                  status: 'pending',
                  claimToken: null,
                  claimedUntil: new Date(
                    Date.now() +
                      Math.min(3600000, 1000 * 2 ** Math.min(row.attempts, 12)),
                  ),
                  lastError:
                    '超时办理失败，稍后重试；请核对流程配置和审批人状态',
                },
                manager,
              );
            });
            this.logger.error({
              event: 'workflow.timer.failed',
              tenantId,
              timerId: job.id,
              detail: '办理已回滚，按退避间隔重试',
            });
          }
        }
      });
    }
  }
}
