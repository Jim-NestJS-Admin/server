import {
  HttpStatus,
  Injectable,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';
import { RedisService } from '../redis/redis.service.js';
import { RequestContext } from '../tenant/request-context.js';
import type { RateLimitRule } from './rate-limit.js';

export const USER_RATE_LIMIT_KEY = 'jna:user-rate-limit';

/**
 * 按当前用户限流（T25）：导出、发短信这类按人算成本的接口，`@UserRateLimit('export', 10, 3600)`。
 * 在认证之后执行，计数键带租户和用户；没有用户（免登录接口）时按规则名 + 租户共用一个计数。
 */
export const UserRateLimit = (
  name: string,
  limit: number,
  windowSeconds: number,
) =>
  SetMetadata(USER_RATE_LIMIT_KEY, {
    name,
    limit,
    windowSeconds,
  } satisfies RateLimitRule);

const HIT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return {c, redis.call('TTL', KEYS[1])}
`;

@Injectable()
export class UserRateLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    private readonly context: RequestContext,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const rule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(
      USER_RATE_LIMIT_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!rule || ctx.getType() !== 'http') return next.handle();
    return from(
      this.check(rule, ctx).then(() =>
        lastValueFrom(next.handle(), { defaultValue: null }),
      ),
    );
  }

  private async check(
    rule: RateLimitRule,
    ctx: ExecutionContext,
  ): Promise<void> {
    const { tenantId, userId } = this.context.current();
    const key = this.redis.tenantKey(tenantId, 'rl', rule.name, userId ?? '-');
    // 按用户的限流和业务一样依赖 Redis：不可用时 503（不放行，避免导出、短信被刷）
    const [count, ttl] = (await this.redis.call((r) =>
      r.eval(HIT, 1, key, rule.windowSeconds),
    )) as [number, number];
    if (count <= rule.limit) return;
    const retry = Math.max(1, ttl);
    ctx
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(retry));
    throw new BusinessException(
      ErrorCode.TooManyRequests,
      '操作太频繁，请稍后再试',
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfterSeconds: retry },
    );
  }
}
