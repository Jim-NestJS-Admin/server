import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantSource } from '../../../core/tenant/tenant-source.js';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { RedisService } from '../../../core/redis/redis.service.js';
import { SessionService } from '../../../core/auth/session.service.js';
import { PermissionService } from '../../../core/permission/permission.service.js';
import { SystemIntegrationService } from '../../system/service/system-integration.service.js';
import { SystemDirectory } from '../../system/service/system-directory.service.js';
import { WorkflowRuntimeService } from '../../workflow/service/workflow-runtime.service.js';
import { WorkflowOutboxService } from '../../workflow/service/workflow-outbox.service.js';
import {
  IntegrationCard,
  IntegrationInbox,
  UserSocial,
} from '../entity/integration.entity.js';
import { IntegrationCrypto } from './integration-crypto.js';
import { IntegrationAppService } from './integration-app.service.js';
import { callbackField } from './integration-callback.service.js';
import { IntegrationSyncService } from './integration-sync.service.js';
import { WecomAdapter } from './wecom-adapter.js';

@Injectable()
export class IntegrationWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('IntegrationWorker');
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly config: AppConfigService,
    private readonly context: RequestContext,
    private readonly tenants: TenantSource,
    private readonly db: DataSource,
    private readonly repos: TenantRepositoryFactory,
    private readonly apps: IntegrationAppService,
    private readonly crypto: IntegrationCrypto,
    private readonly syncer: IntegrationSyncService,
    private readonly redis: RedisService,
    private readonly sessions: SessionService,
    private readonly permissions: PermissionService,
    private readonly system: SystemIntegrationService,
    private readonly directory: SystemDirectory,
    private readonly runtime: WorkflowRuntimeService,
    private readonly workflow: WorkflowOutboxService,
    private readonly adapter: WecomAdapter,
  ) {}
  onApplicationBootstrap() {
    if (this.config.openApiExport || this.config.nodeEnv === 'test') return;
    this.timer = setInterval(() => {
      if (!this.running && !this.stopping)
        this.running = this.scan()
          .catch(() => this.logger.error('企业微信后台任务失败，稍后重试'))
          .finally(() => {
            this.running = undefined;
          });
    }, 10000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  private async scan() {
    for (const tenantId of await this.tenants.activeTenantIds()) {
      if (this.stopping) break;
      await this.context.run({ tenantId }, async () => {
        const app = await this.apps.configured();
        if (!app) return;
        const jobs = await this.repos
          .for(IntegrationInbox)
          .query('i')
          .addSelect('i.payloadCipher')
          .andWhere('i.status = :status AND i.nextAttemptAt <= :now', {
            status: 'pending',
            now: new Date(),
          })
          .orderBy('i.id', 'ASC')
          .limit(10)
          .getMany();
        for (const job of jobs) {
          try {
            const plaintext = this.crypto.decrypt(
              job.payloadCipher,
              `${tenantId}:inbox:${job.eventKey}`,
            );
            const event = callbackField(plaintext, 'Event');
            if (event === 'manual_sync') {
              await this.syncer.sync();
              await this.repos
                .for(IntegrationInbox)
                .update([job.id], { status: 'done' });
            } else if (event === 'template_card_event') {
              await this.approve(job, plaintext);
            } else if (event === 'change_contact') {
              const change = callbackField(plaintext, 'ChangeType');
              if (change === 'delete_user') {
                const external = callbackField(plaintext, 'UserID');
                if (
                  await this.adapter.memberExists(
                    app,
                    this.apps.credentials(app).secret,
                    external,
                  )
                ) {
                  await this.syncer.sync();
                  await this.repos
                    .for(IntegrationInbox)
                    .update([job.id], { status: 'done' });
                  continue;
                }
                const userId = await this.db.transaction((manager) =>
                  this.system.disable(
                    `wecom:${app.corpId}:user:${external}`,
                    manager,
                  ),
                );
                if (userId) {
                  await this.sessions.revokeUser(tenantId, userId);
                  await this.runtime.departed(userId);
                }
                await this.permissions.bumpVersion(tenantId);
              } else if (change === 'delete_party') {
                const departments = await this.adapter.departments(
                  app,
                  this.apps.credentials(app).secret,
                );
                if (
                  departments.some(
                    (d) => String(d.id) === callbackField(plaintext, 'Id'),
                  )
                ) {
                  await this.syncer.sync();
                  await this.repos
                    .for(IntegrationInbox)
                    .update([job.id], { status: 'done' });
                  continue;
                }
                await this.db.transaction((manager) =>
                  this.system.disableOrganization(
                    `wecom:${app.corpId}:org:${callbackField(plaintext, 'Id')}`,
                    manager,
                  ),
                );
                await this.permissions.bumpVersion(tenantId);
              } else await this.syncer.sync();
              await this.repos
                .for(IntegrationInbox)
                .update([job.id], { status: 'done' });
            } else
              await this.repos
                .for(IntegrationInbox)
                .update([job.id], { status: 'done' });
          } catch {
            await this.repos.for(IntegrationInbox).update([job.id], {
              attempts: job.attempts + 1,
              nextAttemptAt: new Date(
                Date.now() +
                  Math.min(3600000, 1000 * 2 ** Math.min(job.attempts + 1, 12)),
              ),
            });
          }
        }
        const cards = await this.repos
          .for(IntegrationCard)
          .query('c')
          .addSelect('c.responseCipher')
          .andWhere('c.updated = :updated AND c.responseCipher IS NOT NULL', {
            updated: false,
          })
          .orderBy('c.id', 'ASC')
          .limit(50)
          .getMany();
        for (const card of cards) {
          const task = await this.workflow.taskReference(card.taskId);
          if (task?.status === 'pending') continue;
          try {
            await this.adapter.api(
              app,
              this.apps.credentials(app).secret,
              'message/update_template_card',
              {},
              {
                userids: [card.externalId],
                agentid: Number(app.agentId),
                response_code: this.crypto.decrypt(
                  card.responseCipher!,
                  this.apps.aad('card:' + card.id),
                ),
                button: {
                  replace_name:
                    task?.status === 'approved'
                      ? '已同意'
                      : task?.status === 'rejected'
                        ? '已驳回'
                        : '已失效',
                },
              },
            );
            await this.repos
              .for(IntegrationCard)
              .update([card.id], { updated: true });
          } catch {
            /* 卡片只反映已提交结果；渠道失败不能再次办理审批。 */
          }
        }
        const now = new Date();
        const hour = Number(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Shanghai',
            hour: '2-digit',
            hourCycle: 'h23',
          }).format(now),
        );
        if (hour !== 2) return;
        const day = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai',
        }).format(now);
        const key = this.redis.tenantKey(tenantId, 'wecom', 'nightly', day);
        if (
          await this.redis.call((r) => r.set(key, 'claimed', 'EX', 3600, 'NX'))
        ) {
          try {
            await this.syncer.sync();
            await this.redis.call((r) => r.set(key, 'done', 'EX', 86400));
          } catch {
            await this.redis.call((r) => r.del(key));
            throw new Error('企业微信夜间同步失败');
          }
        }
      });
    }
  }
  private async approve(job: IntegrationInbox, xml: string) {
    const taskId = callbackField(xml, 'TaskId');
    if (
      !/^[1-9]\d{0,19}$/.test(taskId) ||
      callbackField(xml, 'EventKey') !== 'approve'
    ) {
      await this.repos
        .for(IntegrationInbox)
        .update([job.id], { status: 'done' });
      return;
    }
    const app = await this.apps.configured();
    if (!app || app.id !== job.appId) throw new Error('回调应用已失效');
    const card = await this.repos
      .for(IntegrationCard)
      .query('c')
      .andWhere('c.id = :id AND c.appId = :appId', {
        id: taskId,
        appId: app.id,
      })
      .getOne();
    if (!card || card.externalId !== callbackField(xml, 'FromUserName'))
      throw new Error('卡片办理人不匹配');
    const social = await this.repos
      .for(UserSocial)
      .query('s')
      .andWhere(
        's.userId = :userId AND s.corpId = :corpId AND s.externalId = :externalId',
        {
          userId: card.recipientId,
          corpId: app.corpId,
          externalId: card.externalId,
        },
      )
      .getOne();
    const identity = social
      ? await this.directory.notificationIdentity(social.userId)
      : null;
    if (!identity) throw new Error('卡片办理人已失效');
    const task = await this.workflow.taskReference(card.taskId);
    if (!task || task.status !== 'pending') {
      await this.repos
        .for(IntegrationInbox)
        .update([job.id], { status: 'done' });
      return;
    }
    await this.context.run(
      { tenantId: this.context.current().tenantId, ...identity },
      async () => {
        await this.permissions.authorize('workflow:task:approve');
        await this.runtime.approveFromPlatform(
          { id: card.taskId, version: task.version },
          async (manager) => {
            await this.repos
              .for(IntegrationInbox)
              .update([job.id], { status: 'done' }, manager);
          },
        );
      },
    );
  }
}
