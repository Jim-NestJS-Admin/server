import {
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { AppConfigService } from '../config/app-config.service.js';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';
import { RedisService } from '../redis/redis.service.js';

export const RATE_LIMIT_KEY = 'jna:rate-limit';

export interface RateLimitRule {
  /** 规则名，用在计数键里，例如 login、captcha、sms、export */
  name: string;
  /** 时间窗口内最多几次 */
  limit: number;
  /** 时间窗口（秒） */
  windowSeconds: number;
}

/**
 * 接口级限流（按来源 IP），在 IP 总闸之外再加一道：`@RateLimit('login', 20, 60)`。
 * 可以加在方法或控制器上。按用户限流（导出这类）在认证之后另做。
 */
export const RateLimit = (name: string, limit: number, windowSeconds: number) =>
  SetMetadata(RATE_LIMIT_KEY, {
    name,
    limit,
    windowSeconds,
  } satisfies RateLimitRule);

/** 固定窗口计数：第一次 INCR 时设过期，返回 [计数, 剩余秒数] */
const HIT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return {c, redis.call('TTL', KEYS[1])}
`;

/**
 * 限流守卫（T25，架构「安全基线 · 限流」），排在多端认证守卫前面，所以没登录的请求也会被计数：
 * 1. IP 总闸：每个来源 IP 每分钟最多 RATE_LIMIT_IP_PER_MINUTE 次，不分租户、不分接口；
 * 2. 接口规则：@RateLimit 声明的按「规则 + IP」计数。
 * 超了返回 429 / 4029，带 Retry-After 和 data.retryAfterSeconds。
 * 来源 IP 取 Express 的 req.ip：只有配置了 TRUST_PROXY（受控的反向代理层数）时才信 X-Forwarded-For，伪造的头绕不过去。
 * Redis 不可用时放行限流（只记日志）：受保护接口的认证会因为 Redis 故障直接 503，不会因此被放开。
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger('RateLimit');

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const rules: RateLimitRule[] = [
      {
        name: 'ip',
        limit: this.config.security.ipPerMinute,
        windowSeconds: 60,
      },
    ];
    const route = this.reflector.getAllAndOverride<RateLimitRule | undefined>(
      RATE_LIMIT_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (route) rules.push(route);
    for (const rule of rules) {
      let count: number;
      let ttl: number;
      try {
        [count, ttl] = (await this.redis.client.eval(
          HIT,
          1,
          `rl:${rule.name}:${ip}`,
          rule.windowSeconds,
        )) as [number, number];
      } catch (e) {
        this.logger.warn({
          event: 'rate-limit.redis-unavailable',
          err: String(e),
        });
        return true;
      }
      if (count > rule.limit) {
        const retry = Math.max(1, ttl);
        res.setHeader('Retry-After', String(retry));
        throw new BusinessException(
          ErrorCode.TooManyRequests,
          '请求太频繁，请稍后再试',
          HttpStatus.TOO_MANY_REQUESTS,
          { retryAfterSeconds: retry },
        );
      }
    }
    return true;
  }
}
