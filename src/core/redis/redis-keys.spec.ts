import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 契约 tenant.md 第 8 节：按租户的 Redis 键一律用 RedisService.tenantKey 拼。
 * 这里扫描源码：Redis 命令的第一个参数不能直接写字符串（'...' 或 `...`），
 * 只有明确不分租户的全局键（白名单）例外。新增全局键要在白名单里写明理由。
 */
const GLOBAL_ALLOWED: Record<string, string> = {
  'src/core/security/rate-limit.ts':
    'IP 总闸和接口级 IP 限流，按来源 IP 计数，不分租户（架构「安全基线」）',
};

const root = join(import.meta.dirname, '..', '..', '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

// redis.call((r) => ...) 里对客户端 r 发的命令（含 multi() 链）：命令名后面紧跟字符串字面量就是违规
const LITERAL_KEY =
  /\br\s*(?:\.\s*multi\(\)\s*)?\.\s*(get|set|del|incr|incrby|decr|expire|pexpire|ttl|hget|hset|hmget|hgetall|hdel|sadd|srem|smembers|zadd|zrem|zrange|exists)\(\s*['`]/g;

describe('Redis 键必须带租户前缀', () => {
  it('源码里没有直接写字符串的 Redis 键（白名单除外）', () => {
    const bad: string[] = [];
    for (const file of files(join(root, 'src'))) {
      const rel = relative(root, file).replaceAll('\\', '/');
      if (GLOBAL_ALLOWED[rel]) continue;
      const text = readFileSync(file, 'utf8');
      if (!/redis/i.test(text)) continue;
      for (const m of text.matchAll(LITERAL_KEY)) {
        const line = text.slice(0, m.index).split('\n').length;
        bad.push(`${rel}:${line} ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
