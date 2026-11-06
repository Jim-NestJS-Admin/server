import { Redis } from 'ioredis';

/** 端到端测试的 Redis 键前缀（vitest.config.e2e.ts 里配置），清理时只删这个前缀下的键 */
export const TEST_REDIS_PREFIX = 'jna-test:';

/** 不带前缀的原始连接：测试直接查看、清理、篡改 Redis 里的数据 */
export function rawRedis(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB ?? 0),
  });
}

export async function clearTestRedis(redis: Redis): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${TEST_REDIS_PREFIX}*`,
      'COUNT',
      500,
    );
    if (keys.length) await redis.del(...keys);
    cursor = next;
  } while (cursor !== '0');
}
