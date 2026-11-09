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
import {
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyLedger,
  type IdempotencyClaim,
} from './idempotency.ledger.js';

const HEADER = 'idempotency-key';
/** 处理中的占位最多 60 秒（进程崩溃后能重试；数据库记录才是最终依据） */
const PROCESSING_TTL = 60;

const conflict = (message: string) =>
  new BusinessException(ErrorCode.Conflict, message, HttpStatus.CONFLICT);

interface Cached {
  owner: string;
  digest: string;
  status: 'processing' | 'done';
  result?: unknown;
}

/**
 * 幂等（T25，架构「安全基线 · 幂等」）：写接口（带 @Perms 的非 GET 请求）带 `Idempotency-Key` 头时，
 * 同一个键只执行一次，重复提交直接返回第一次的结果。
 * - 记录绑定租户、组织、调用人、权限码（动作）和请求内容摘要；换了人、动作或内容再用同一个键：409。
 * - 最终依据是数据库 sys_idempotency：和业务数据同一个事务提交（IdempotencyLedger.transaction，
 *   CRUD 基类已接好），进程在返回前崩溃也不会重复执行。Redis 只做「处理中」占位和结果缓存。
 * - 处理中：第二个请求 409「正在处理」；失败：事务整体回滚，记录不留，可以用同一个键重试；
 *   成功：保存结果 24 小时。
 * - 拦截器在守卫之后运行，命中时身份、当前组织和权限码都已按当前状态重新校验过。
 * 请求没带这个头时照常执行。
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    private readonly context: RequestContext,
    private readonly ledger: IdempotencyLedger,
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
    const claim: IdempotencyClaim = {
      tenantId,
      userId: userId ?? '-',
      key,
      owner: JSON.stringify([orgId, userId, action]),
      digest: createHash('sha256')
        .update(
          `${req.method} ${req.path}\n${JSON.stringify(req.body ?? null)}`,
        )
        .digest('base64url'),
    };
    const rk = this.redis.tenantKey(tenantId, 'idem', claim.userId, key);
    const same = (r: { owner: string; digest: string }) =>
      r.owner === claim.owner && r.digest === claim.digest;
    const cacheDone = (result: unknown) =>
      this.redis.call((r) =>
        r.set(
          rk,
          JSON.stringify({ ...this.bind(claim), status: 'done', result }),
          'EX',
          IDEMPOTENCY_TTL_SECONDS,
        ),
      );

    const claimed = await this.redis.call((r) =>
      r.set(
        rk,
        JSON.stringify({ ...this.bind(claim), status: 'processing' }),
        'EX',
        PROCESSING_TTL,
        'NX',
      ),
    );
    if (claimed !== 'OK') {
      const raw = await this.redis.call((r) => r.get(rk));
      const prev = raw ? (JSON.parse(raw) as Cached) : null;
      if (!prev) throw conflict('请求正在处理，请稍后刷新查看结果');
      if (!same(prev)) throw conflict('这个幂等键已经用于别的请求');
      if (prev.status === 'done') return prev.result;
      throw conflict('请求正在处理，请稍后刷新查看结果');
    }

    try {
      // Redis 里没有（过期、被清空或上次执行时进程崩溃）：以数据库记录为准
      const stored = await this.ledger.find(claim);
      if (stored) {
        if (!same(stored)) throw conflict('这个幂等键已经用于别的请求');
        await cacheDone(stored.result);
        return stored.result;
      }
      this.ledger.begin(claim);
      const result = await lastValueFrom(next.handle(), { defaultValue: null });
      await this.ledger.complete(result);
      await cacheDone(result);
      return result;
    } catch (e) {
      const p = this.ledger.pending();
      // 业务事务已经提交（之后的步骤才失败）：记录还在，重试时返回事务里的结果
      if (p?.recorded) await cacheDone(p.txResult).catch(() => undefined);
      else await this.redis.call((r) => r.del(rk)).catch(() => undefined);
      throw e;
    }
  }

  private bind(c: IdempotencyClaim): { owner: string; digest: string } {
    return { owner: c.owner, digest: c.digest };
  }
}
