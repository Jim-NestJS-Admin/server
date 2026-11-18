import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantSource } from '../../../core/tenant/tenant-source.js';
import { AiQueueService } from './ai-queue.service.js';
@Injectable()
export class AiWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('AiWorker');
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly config: AppConfigService,
    private readonly tenants: TenantSource,
    private readonly context: RequestContext,
    private readonly queue: AiQueueService,
  ) {}
  onApplicationBootstrap() {
    if (
      this.config.openApiExport ||
      this.config.nodeEnv === 'test' ||
      !this.config.ai.masterKey
    )
      return;
    this.timer = setInterval(() => {
      if (!this.running && !this.stopping)
        this.running = this.scan()
          .catch(() =>
            this.logger.error(
              'AI任务扫描失败，等待下一轮；不记录输入或提供方错误原文',
            ),
          )
          .finally(() => {
            this.running = undefined;
          });
    }, 3000);
    this.timer.unref();
  }
  private async scan() {
    for (const tenantId of await this.tenants.activeTenantIds()) {
      if (this.stopping) break;
      if (tenantId === '0') continue;
      try {
        if (!(await this.tenants.byId(tenantId))?.enabled) continue;
        await this.context.run({ tenantId }, () => this.queue.dispatch());
      } catch {
        this.logger.warn({ event: 'ai.task.scan.failed', tenantId });
      }
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
