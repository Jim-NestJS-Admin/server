import { createHash } from 'node:crypto';
import {
  HttpStatus,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';
import { PERMS_KEY, type PermMeta } from '../permission/perms.decorator.js';
import { RedisService } from '../redis/redis.service.js';
import { RequestContext } from '../tenant/request-context.js';

const HEADER = 'idempotency-key';
/** 成功结果保留 24 小时；处理中最多占 60 秒（进程崩溃后能重试） */
const DONE_TTL = 86400;
const PROCESSING_TTL = 60;

const conflict = (message: string) =>
  new BusinessException(ErrorCode.Conflict, message, HttpStatus.CONFLICT);

/**
 * 幂等（T25，架构「安全基线 · 幂等」）：写接口（带 @Perms 的非 GET 请求）带 `Idempotency-Key` 头时，
 * 同一个键只执行一次，重复提交直接返回第一次的结果。
 * - 记录绑定租户、组织、调用人、权限码（动作）和请求内容摘要；换了人、动作或内容再用同一个键：409。
 * - 处理中：第二个请求 409「正在处理」；失败：删掉记录，可以用同一个键重试；成功：保存结果 24 小时。
 * - 拦截器在守卫之后运行，命中时也已经重新校验过身份和权限。
 * 和架构的差异：记录放在 Redis，没有和业务写在同一个数据库事务里；需要强一致的外部动作走发件箱（以后的任务）。
 * 请求没带这个头时照常执行。
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    private readonly context: RequestContext,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = req.header(HEADER);
    const perm = this.reflector.get<PermMeta | undefined>(
      PERMS_KEY,
      ctx.getHandler(),
    );
    if (!key || !perm || req.method === 'GET') return next.handle();
    return from(this.run(key, perm.code, req, next));
  }

  private async run(
    key: string,
    action: string,
    req: Request,
    next: CallHandler,
  ): Promise<unknown> {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key))
      throw new BusinessException(
        ErrorCode.BadRequest,
        'Idempotency-Key 格式不对：8 到 64 个字母、数字、- 或 _',
        HttpStatus.BAD_REQUEST,
      );
    const { tenantId, orgId, userId } = this.context.current();
    const owner = JSON.stringify([orgId, userId, action]);
    const digest = createHash('sha256')
      .update(`${req.method} ${req.path}\n${JSON.stringify(req.body ?? null)}`)
      .digest('base64url');
    const rk = this.redis.tenantKey(tenantId, 'idem', userId ?? '-', key);
    const record = JSON.stringify({ owner, digest, status: 'processing' });
    const claimed = await this.redis.call((r) =>
      r.set(rk, record, 'EX', PROCESSING_TTL, 'NX'),
    );
    if (claimed !== 'OK') {
      const raw = await this.redis.call((r) => r.get(rk));
      const prev = raw
        ? (JSON.parse(raw) as {
            owner: string;
            digest: string;
            status: string;
            result?: unknown;
          })
        : null;
      if (!prev) throw conflict('请求正在处理，请稍后刷新查看结果');
      if (prev.owner !== owner || prev.digest !== digest)
        throw conflict('这个幂等键已经用于别的请求');
      if (prev.status === 'done') return prev.result;
      throw conflict('请求正在处理，请稍后刷新查看结果');
    }
    try {
      const result = await lastValueFrom(next.handle(), { defaultValue: null });
      await this.redis.call((r) =>
        r.set(
          rk,
          JSON.stringify({ owner, digest, status: 'done', result }),
          'EX',
          DONE_TTL,
        ),
      );
      return result;
    } catch (e) {
      await this.redis.call((r) => r.del(rk)).catch(() => undefined);
      throw e;
    }
  }
}
