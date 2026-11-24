import {
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantSource } from '../../../core/tenant/tenant-source.js';
import { PLATFORM_TENANT_ID } from '../../../core/tenant/tenant.constants.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { PermissionService } from '../../../core/permission/permission.service.js';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { SystemDirectory } from '../../system/service/system-directory.service.js';
import { WorkflowOutboxService } from '../../workflow/service/workflow-outbox.service.js';
import {
  NotifyDelivery,
  NotifyMessage,
  NotifyReceipt,
} from '../entity/notify.entity.js';
import {
  NotificationBusinessRegistry,
  NotificationChannel,
  type NotificationReference,
} from './notify-ports.js';

const TITLES: Record<string, string> = {
  'task.created': '您有一项新的审批待办',
  'task.copied': '您收到一项审批抄送',
  'task.reminder': '您的审批待办需要处理',
  'task.cancelled': '您的审批任务已失效',
  'instance.approved': '您的审批申请已通过',
  'instance.returned': '您的审批申请已退回',
  'instance.withdrawn': '审批申请已撤回',
};

@Injectable()
export class NotifyWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('NotifyWorker');
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly db: DataSource,
    private readonly config: AppConfigService,
    private readonly context: RequestContext,
    private readonly tenants: TenantSource,
    private readonly repos: TenantRepositoryFactory,
    private readonly outbox: WorkflowOutboxService,
    private readonly directory: SystemDirectory,
    private readonly permissions: PermissionService,
    private readonly business: NotificationBusinessRegistry,
    @Optional() private readonly channel?: NotificationChannel,
  ) {}

  onApplicationBootstrap() {
    if (this.config.openApiExport || this.config.nodeEnv === 'test') return;
    this.timer = setInterval(() => {
      if (!this.running && !this.stopping)
        this.running = this.scan()
          .catch(() =>
            this.logger.error({
              event: 'notify.scan.failed',
              detail: '消息处理失败，下一轮继续重试',
            }),
          )
          .finally(() => {
            this.running = undefined;
          });
    }, 5000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  private async scan() {
    const tenantIds = new Set([
      PLATFORM_TENANT_ID,
      ...(await this.tenants.activeTenantIds()),
    ]);
    for (const tenantId of tenantIds) {
      if (this.stopping) break;
      if (!(await this.tenants.byId(tenantId))?.enabled) continue;
      await this.context.run({ tenantId }, async () => {
        await this.consume();
        if (this.channel) await this.deliver();
      });
    }
  }

  private async consume() {
    await this.db.transaction(async (manager) => {
      for (const event of await this.outbox.pending(manager)) {
        if (!event.recipientId) {
          const existing = await this.repos
            .for(NotifyReceipt)
            .query('r', manager)
            .andWhere('r.eventKey = :key', { key: event.eventKey })
            .getOne();
          if (!existing) {
            const reference = await this.outbox.business(
              event.instanceId,
              manager,
            );
            if (!reference) throw new Error('审批业务引用已不存在');
            await this.business.approved(
              reference.type,
              reference.id,
              event.eventKey,
              manager,
            );
            await this.repos.for(NotifyReceipt).insert(
              {
                eventKey: event.eventKey,
                businessType: reference.type,
                businessId: reference.id,
              },
              manager,
            );
          }
        } else {
          const existing = await this.repos
            .for(NotifyMessage)
            .query('m', manager)
            .andWhere('m.eventKey = :key', { key: event.eventKey })
            .getOne();
          if (!existing) {
            const messageId = await this.repos.for(NotifyMessage).insert(
              {
                eventKey: event.eventKey,
                event: event.event,
                recipientId: event.recipientId,
                title: TITLES[event.event] ?? '审批状态有更新',
                instanceId: event.instanceId,
                taskId: event.taskId,
                readAt: null,
              },
              manager,
            );
            for (const channel of (await this.channel?.channels(
              event.recipientId,
            )) ?? [])
              await this.repos.for(NotifyDelivery).insert(
                {
                  messageId,
                  channel,
                  status: 'pending',
                  attempts: 0,
                  nextAttemptAt: new Date(),
                  claimToken: null,
                  claimedUntil: null,
                  lastError: '',
                  externalId: null,
                },
                manager,
              );
          }
        }
        await this.outbox.acknowledge(event.id, manager);
      }
    });
  }

  private async deliver() {
    const jobs = await this.db.transaction(async (manager) => {
      const rows = await this.repos
        .for(NotifyDelivery)
        .query('d', manager)
        .andWhere(
          '((d.status = :pending AND d.nextAttemptAt <= :now) OR (d.status = :claimed AND d.claimedUntil <= :now))',
          { pending: 'pending', claimed: 'claimed', now: new Date() },
        )
        .orderBy('d.id', 'ASC')
        .limit(10)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();
      for (const row of rows) {
        row.claimToken = randomUUID();
        row.attempts++;
        await this.repos.for(NotifyDelivery).update(
          [row.id],
          {
            status: 'claimed',
            claimToken: row.claimToken,
            claimedUntil: new Date(Date.now() + 60000),
            attempts: row.attempts,
          },
          manager,
        );
      }
      return rows;
    });
    for (const job of jobs) {
      if (this.stopping) break;
      let status: NotifyDelivery['status'] = 'pending';
      let externalId: string | null = null;
      try {
        const message = await this.repos
          .for(NotifyMessage)
          .query('m')
          .andWhere('m.id = :id', { id: job.messageId })
          .getOne();
        if (!message || !(await this.allowed(message))) status = 'cancelled';
        else {
          externalId = await this.channel!.send(job.channel, message);
          status = 'sent';
        }
      } catch {
        /* 不持久化第三方原始错误，防止错误中包含访问令牌或消息内容。 */
      }
      await this.db.transaction(async (manager) => {
        const current = await this.repos
          .for(NotifyDelivery)
          .query('d', manager)
          .andWhere('d.id = :id', { id: job.id })
          .setLock('pessimistic_write')
          .getOne();
        if (
          current?.status !== 'claimed' ||
          current.claimToken !== job.claimToken ||
          !current.claimedUntil ||
          current.claimedUntil.getTime() <= Date.now()
        )
          return;
        await this.repos.for(NotifyDelivery).update(
          [job.id],
          {
            status,
            externalId,
            claimToken: null,
            claimedUntil: null,
            nextAttemptAt: new Date(
              Date.now() +
                Math.min(3600000, 1000 * 2 ** Math.min(job.attempts, 12)),
            ),
            lastError: status === 'pending' ? '投递失败，将按退避间隔重试' : '',
          },
          manager,
        );
      });
    }
  }

  private async allowed(message: NotificationReference) {
    const identity = await this.directory.notificationIdentity(
      message.recipientId,
    );
    if (!identity) return false;
    try {
      return await this.context.run(
        { ...identity, tenantId: this.context.current().tenantId },
        async () => {
          await this.permissions.authorize('workflow:instance:info');
          return this.outbox.recipientVisible(
            message.instanceId,
            message.recipientId,
            message.event,
            message.taskId,
          );
        },
      );
    } catch (error) {
      if (
        error instanceof BusinessException &&
        [403, 401, 404].includes(error.getStatus())
      )
        return false;
      throw error;
    }
  }
}
