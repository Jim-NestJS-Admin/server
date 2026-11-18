import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { RedisService } from '../../../core/redis/redis.service.js';
import { AiService } from './ai.service.js';
/** DB任务为发件箱；队列仅存引用，重复派发由数据库租约去重。 */
@Injectable()
export class AiQueueService implements OnModuleDestroy {
  private readonly logger = new Logger('AiQueue');
  private queues = new Map<string, { queue: Queue; worker: Worker }>();
  constructor(
    private readonly config: AppConfigService,
    private readonly context: RequestContext,
    private readonly ai: AiService,
    private readonly redis: RedisService,
  ) {}
  private port(tenantId: string) {
    let entry = this.queues.get(tenantId);
    if (entry) return entry;
    const c = this.config.redis,
      options = {
        connection: {
          host: c.host,
          port: c.port,
          password: c.password,
          db: c.db,
          maxRetriesPerRequest: null,
        },
        prefix: c.keyPrefix + this.redis.tenantKey(tenantId, 'ai'),
      };
    const queue = new Queue('tasks', {
        ...options,
        connection: {
          ...options.connection,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        },
      }),
      worker = new Worker(
        'tasks',
        async (job) =>
          this.context.run({ tenantId }, () =>
            this.ai.runPending(
              job.data.id === undefined ? '0' : String(job.data.id),
            ),
          ),
        { ...options, concurrency: 1 },
      );
    worker.on('error', () =>
      this.logger.warn({ event: 'ai.worker.failed', tenantId }),
    );
    queue.on('error', () => undefined);
    entry = { queue, worker };
    this.queues.set(tenantId, entry);
    return entry;
  }
  async dispatch() {
    if (!(await this.ai.hasWork())) return;
    const tenantId = this.context.current().tenantId,
      { queue } = this.port(tenantId);
    await queue.add(
      'recover',
      {},
      { jobId: 'recover', removeOnComplete: true, removeOnFail: true },
    );
    for (const task of await this.ai.queued())
      await queue.add(
        'generate',
        { id: task.id },
        {
          jobId: `task-${task.id}`,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
  }
  async onModuleDestroy() {
    await Promise.all(
      [...this.queues.values()].map(async (x) => {
        await x.worker.close();
        await x.queue.close();
      }),
    );
  }
}
