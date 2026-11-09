import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  applyDecorators,
  HttpStatus,
  Injectable,
  SetMetadata,
  StreamableFile,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type Type,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type {} from 'multer';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { RAW_RESPONSE } from '../decorators/raw-response.decorator.js';
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
/** 上传接口：幂等在文件解析之后做（见 {@link IdempotentUpload}） */
export const IDEMPOTENT_UPLOAD = 'jna:idempotent-upload';

const conflict = (message: string) =>
  new BusinessException(ErrorCode.Conflict, message, HttpStatus.CONFLICT);

interface Cached {
  owner: string;
  digest: string;
  status: 'processing' | 'done';
  result?: unknown;
}

/** 文件、流、二进制：不能按 JSON 保存和重放 */
export const isBinaryResult = (v: unknown): boolean =>
  v instanceof StreamableFile ||
  v instanceof Readable ||
  Buffer.isBuffer(v) ||
  v instanceof Uint8Array ||
  v instanceof ArrayBuffer;

type UploadedFiles =
  | Express.Multer.File
  | Express.Multer.File[]
  | Record<string, Express.Multer.File[]>
  | undefined;

/** multer 解析出的全部文件（单个、数组、按字段分组），按字段名和顺序排好 */
function filesOf(req: Request): Express.Multer.File[] {
  const r = req as Request & {
    file?: Express.Multer.File;
    files?: UploadedFiles;
  };
  const out: Express.Multer.File[] = [];
  if (r.file) out.push(r.file);
  const fs = r.files;
  if (Array.isArray(fs)) out.push(...fs);
  else if (fs && typeof fs === 'object')
    for (const k of Object.keys(fs).sort()) out.push(...(fs[k] ?? []));
  return out;
}

/**
 * 幂等（T25，架构「安全基线 · 幂等」）的执行逻辑，全局拦截器和上传拦截器共用。
 * - 记录绑定租户、组织、调用人、权限码（动作）和请求内容摘要；换了人、动作或内容再用同一个键：409。
 * - 最终依据是数据库 sys_idempotency：和业务数据同一个事务提交（IdempotencyLedger.transaction，
 *   CRUD 基类已接好），进程在返回前崩溃也不会重复执行。Redis 只做「处理中」占位和结果缓存。
 * - 处理中：第二个请求 409「正在处理」；成功：保存结果 24 小时。
 * - 失败：只释放 Redis 占位，不宣称成功或失败。事务回滚了记录就不在，同一个键可以重试；
 *   提交结果不确定时，重试会查到（或查不到）数据库记录，以它为准。
 * - 拦截器在守卫之后运行，命中时身份、当前组织和权限码都已按当前状态重新校验过。
 * - 二进制结果（文件下载、CSV、ZIP）不保存、不重放：原样返回给本次请求，Redis 占位释放。
 */
@Injectable()
export class IdempotencyRunner {
  constructor(
    private readonly redis: RedisService,
    private readonly context: RequestContext,
    private readonly ledger: IdempotencyLedger,
  ) {}

  /** 本次请求的内容摘要：方法、路径、JSON 请求体；上传时再加每个文件的字段名、大小和内容哈希 */
  digest(req: Request, withFiles: boolean): string {
    const h = createHash('sha256').update(
      `${req.method} ${req.path}\n${JSON.stringify(req.body ?? null)}`,
    );
    if (withFiles)
      for (const f of filesOf(req)) {
        if (!f.buffer)
          throw new Error(
            '幂等上传只支持内存存储（memoryStorage）：拿不到文件内容就无法计算摘要',
          );
        h.update(`\n${f.fieldname}:${f.size}:`);
        h.update(createHash('sha256').update(f.buffer).digest('hex'));
      }
    return h.digest('base64url');
  }

  async run(
    key: string,
    action: string,
    digest: string,
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
      digest,
    };
    const rk = this.redis.tenantKey(tenantId, 'idem', claim.userId, key);
    const bind = { owner: claim.owner, digest: claim.digest };
    const same = (r: { owner: string; digest: string }) =>
      r.owner === claim.owner && r.digest === claim.digest;
    const cacheDone = (result: unknown) =>
      this.redis.call((r) =>
        r.set(
          rk,
          JSON.stringify({ ...bind, status: 'done', result }),
          'EX',
          IDEMPOTENCY_TTL_SECONDS,
        ),
      );
    const release = () =>
      this.redis.call((r) => r.del(rk)).catch(() => undefined);

    const claimed = await this.redis.call((r) =>
      r.set(
        rk,
        JSON.stringify({ ...bind, status: 'processing' }),
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
      if (isBinaryResult(result)) {
        // 二进制结果不保存：已经在事务里写的记录保留（业务已提交），之后同键重试会重放 JSON 结果，
        // 所以会改数据的接口不要返回二进制
        this.ledger.skip();
        await release();
        return result;
      }
      await this.ledger.complete(result);
      await cacheDone(result);
      return result;
    } catch (e) {
      await release();
      throw e;
    }
  }
}

/**
 * 全局幂等拦截器：写接口（带 @Perms 的非 GET 请求）带 `Idempotency-Key` 头时生效。
 * - 原样返回文件的接口（@RawResponse：下载、导出 CSV、ZIP）是只读的，不做幂等，带了键也照常执行；
 * - 上传接口用 {@link IdempotentUpload}，在文件解析之后做；
 * - multipart 请求落到没有 @IdempotentUpload 的接口上：拿不到文件内容算摘要，带键时直接 400，
 *   不会悄悄跳过幂等。
 * 请求没带这个头时照常执行。
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly runner: IdempotencyRunner,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = req.header(HEADER);
    const handler = ctx.getHandler();
    const perm = this.reflector.get<PermMeta | undefined>(PERMS_KEY, handler);
    if (!key || !perm || req.method === 'GET') return next.handle();
    if (
      this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [
        handler,
        ctx.getClass(),
      ])
    )
      return next.handle();
    if (this.reflector.get<boolean>(IDEMPOTENT_UPLOAD, handler))
      return next.handle();
    if (req.is('multipart/form-data'))
      throw new BusinessException(
        ErrorCode.BadRequest,
        '这个接口不支持带 Idempotency-Key 的文件上传',
        HttpStatus.BAD_REQUEST,
      );
    return from(
      this.runner.run(key, perm.code, this.runner.digest(req, false), next),
    );
  }
}

/** 上传接口的幂等：排在文件解析拦截器后面，摘要里包含文件内容 */
@Injectable()
export class UploadIdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly runner: IdempotencyRunner,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = req.header(HEADER);
    const perm = this.reflector.get<PermMeta | undefined>(
      PERMS_KEY,
      ctx.getHandler(),
    );
    if (!key || !perm) return next.handle();
    return from(
      this.runner.run(key, perm.code, this.runner.digest(req, true), next),
    );
  }
}

/**
 * 上传接口用它代替 `@UseInterceptors(FileInterceptor(...))`：
 * `@IdempotentUpload(FileInterceptor('file'))`。保证先解析文件、再按「请求体 + 文件内容」做幂等。
 * 文件解析要用内存存储（Nest 默认），否则拿不到内容会直接报错。
 */
export const IdempotentUpload = (
  ...fileInterceptors: (Type<NestInterceptor> | NestInterceptor)[]
) =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_UPLOAD, true),
    UseInterceptors(...fileInterceptors, UploadIdempotencyInterceptor),
  );
