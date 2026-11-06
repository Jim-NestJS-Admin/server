import {
  HttpStatus,
  Injectable,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfigService } from '../config/app-config.service.js';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';

/**
 * Redis 连接。键统一带配置的前缀（REDIS_KEY_PREFIX），按租户的键再用 tenantKey 拼 t:{tenantId}: 前缀。
 * 连接断开时命令立即失败（不排队等重连），调用方用 call() 把故障转成 503「服务暂不可用」，
 * 受保护的接口不会因为查不到会话就放行（架构「安全基线 · 账号与会话」）。
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly client: Redis;

  constructor(config: AppConfigService) {
    const c = config.redis;
    this.client = new Redis({
      host: c.host,
      port: c.port,
      password: c.password,
      db: c.db,
      keyPrefix: c.keyPrefix,
      // 导出接口文档时不连 Redis
      lazyConnect: config.openApiExport,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    });
    // 连接错误由命令调用方处理；这里只避免未处理的 error 事件让进程退出
    this.client.on('error', () => undefined);
  }

  /** 租户内的键：t:{tenantId}:a:b:c（前缀由客户端统一加） */
  tenantKey(tenantId: string, ...parts: string[]): string {
    return ['t', tenantId, ...parts].join(':');
  }

  /** 执行 Redis 操作；Redis 不可用时抛 503，业务代码不用自己判断 */
  async call<T>(fn: (redis: Redis) => Promise<T>): Promise<T> {
    try {
      return await fn(this.client);
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      throw new BusinessException(
        ErrorCode.ServiceUnavailable,
        undefined,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status === 'end') return;
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
