import { randomUUID } from 'node:crypto';
import type { RedisService } from '../../../core/redis/redis.service.js';

/** 跨进程同步互斥：续租失败后禁止进入写事务，释放只能删除自己持有的锁。 */
export async function withIntegrationLease<T>(
  redis: RedisService,
  tenantId: string,
  operation: string,
  fn: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const key = redis.tenantKey(tenantId, 'integration', 'lease', operation),
    token = randomUUID();
  if (!(await redis.call((r) => r.set(key, token, 'EX', 120, 'NX'))))
    throw new Error('企业微信任务正在处理中');
  let lost = false;
  const renew = setInterval(() => {
    void redis
      .call((r) =>
        r.eval(
          "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('EXPIRE',KEYS[1],120) end return 0",
          1,
          key,
          token,
        ),
      )
      .then((result) => {
        if (result !== 1) lost = true;
      })
      .catch(() => {
        lost = true;
      });
  }, 30000);
  renew.unref();
  try {
    return await fn(async () => {
      if (lost || (await redis.call((r) => r.get(key))) !== token)
        throw new Error('同步任务租约失效');
    });
  } finally {
    clearInterval(renew);
    await redis.call((r) =>
      r.eval(
        "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
        1,
        key,
        token,
      ),
    );
  }
}
