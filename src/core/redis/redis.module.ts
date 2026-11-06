import { Global, Module } from '@nestjs/common';
import { HealthService } from '../health/health.service.js';
import { RedisService } from './redis.service.js';

/** Redis：会话、令牌、人机验证、登录失败计数，以后还有限流、缓存、分布式锁（架构「技术选型」） */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {
  constructor(health: HealthService, redis: RedisService) {
    health.register('redis', async () => {
      await redis.client.ping();
    });
  }
}
