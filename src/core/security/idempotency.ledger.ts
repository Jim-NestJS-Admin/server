import { HttpStatus, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  Column,
  CreateDateColumn,
  DataSource,
  Entity,
  Index,
  LessThanOrEqual,
  MoreThan,
  PrimaryGeneratedColumn,
  QueryFailedError,
  type EntityManager,
} from 'typeorm';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';

/** 去重记录保留 24 小时（架构「安全基线 · 幂等」） */
export const IDEMPOTENCY_TTL_SECONDS = 86400;

/**
 * 幂等记录（T25）。和业务数据在同一个事务里写入：业务提交成功，记录一定也在；
 * 进程在返回前崩溃，客户端用同一个键重试时查到记录，直接返回结果，不会再执行一次。
 */
@Entity('sys_idempotency')
@Index('uk_sys_idempotency', ['tenantId', 'userId', 'idemKey'], {
  unique: true,
})
export class IdempotencyEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ type: 'bigint', unsigned: true })
  tenantId: string;

  /** 调用人；没有登录用户时是 - */
  @Column({ type: 'varchar', length: 32 })
  userId: string;

  @Column({ type: 'varchar', length: 64 })
  idemKey: string;

  /** 绑定的组织、调用人、动作（权限码），JSON 数组 */
  @Column({ type: 'varchar', length: 255 })
  owner: string;

  /** 请求方法、路径和请求体的 SHA-256 摘要 */
  @Column({ type: 'varchar', length: 64 })
  digest: string;

  /** 第一次执行的结果（统一响应包装之前的业务数据） */
  @Column({ type: 'json', nullable: true })
  result: unknown;

  @CreateDateColumn({ type: 'datetime', precision: 3 })
  createdAt: Date;

  @Index()
  @Column({ type: 'datetime', precision: 3 })
  expiresAt: Date;
}

export interface IdempotencyClaim {
  tenantId: string;
  userId: string;
  key: string;
  owner: string;
  digest: string;
}

interface Pending extends IdempotencyClaim {
  /** 已经在业务事务里写过记录 */
  recorded: boolean;
  /** 事务里记下的结果，事务后整个请求失败时用它补 Redis */
  txResult?: unknown;
}

const CLS_KEY = 'jna:idempotency';

const processing = () =>
  new BusinessException(
    ErrorCode.Conflict,
    '请求正在处理，请稍后刷新查看结果',
    HttpStatus.CONFLICT,
  );

const isDuplicate = (e: unknown) =>
  e instanceof QueryFailedError &&
  (e as QueryFailedError & { driverError?: { code?: string } }).driverError
    ?.code === 'ER_DUP_ENTRY';

/**
 * 幂等记录账本。拦截器在执行前登记「本次请求带了幂等键」（放在请求上下文里），
 * 写操作的事务提交前由 {@link transaction} 把记录写进同一个事务。
 *
 * 业务代码的写操作：CRUD 基类已经接好；自定义 Service 要开事务时用 `ledger.transaction(...)`，
 * 不要直接用 dataSource.transaction，否则幂等记录只能在事务之后补写（崩溃时可能重复执行）。
 * 一个写请求只开一个事务；开了多个时只有第一个带上记录。
 */
@Injectable()
export class IdempotencyLedger {
  constructor(
    private readonly cls: ClsService,
    private readonly dataSource: DataSource,
  ) {}

  /** 开一个写事务；本次请求带了幂等键时，提交前把幂等记录写进同一个事务 */
  async transaction<R>(fn: (manager: EntityManager) => Promise<R>): Promise<R> {
    return this.dataSource.transaction(async (manager) => {
      const result = await fn(manager);
      await this.recordInTx(manager, result);
      return result;
    });
  }

  /** 已经自己开了事务时，在事务最后调用它 */
  async recordInTx(manager: EntityManager, result: unknown): Promise<void> {
    const p = this.pending();
    if (!p || p.recorded) return;
    await this.insert(manager, p, result);
    p.recorded = true;
    p.txResult = result;
  }

  // ---- 下面给拦截器用 ----

  begin(claim: IdempotencyClaim): void {
    if (this.cls.isActive())
      this.cls.set<Pending>(CLS_KEY, { ...claim, recorded: false });
  }

  pending(): Pending | undefined {
    return this.cls.isActive() ? this.cls.get<Pending>(CLS_KEY) : undefined;
  }

  /** 未过期的记录 */
  async find(claim: IdempotencyClaim): Promise<IdempotencyEntity | null> {
    return this.dataSource.getRepository(IdempotencyEntity).findOne({
      where: {
        tenantId: claim.tenantId,
        userId: claim.userId,
        idemKey: claim.key,
        expiresAt: MoreThan(new Date()),
      },
    });
  }

  /**
   * 请求成功后：事务里写过就把结果改成最终返回的数据；没走带账本的事务（例如只调了外部接口）就在这里补写。
   */
  async complete(result: unknown): Promise<void> {
    const p = this.pending();
    if (!p) return;
    if (p.recorded) {
      await this.dataSource
        .getRepository(IdempotencyEntity)
        .update(
          { tenantId: p.tenantId, userId: p.userId, idemKey: p.key },
          { result: result as object },
        );
      return;
    }
    await this.dataSource.transaction((m) => this.insert(m, p, result));
    p.recorded = true;
  }

  private async insert(
    manager: EntityManager,
    p: IdempotencyClaim,
    result: unknown,
  ): Promise<void> {
    const repo = manager.getRepository(IdempotencyEntity);
    // 过期的旧记录不再生效，先清掉，免得唯一约束挡住同一个键的新请求
    await repo.delete({
      tenantId: p.tenantId,
      userId: p.userId,
      idemKey: p.key,
      expiresAt: LessThanOrEqual(new Date()),
    });
    try {
      await repo.insert({
        tenantId: p.tenantId,
        userId: p.userId,
        idemKey: p.key,
        owner: p.owner,
        digest: p.digest,
        result: (result ?? null) as object,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000),
      });
    } catch (e) {
      // 同一个键的另一个请求已经提交：本次事务回滚，告诉调用方去看第一次的结果
      if (isDuplicate(e)) throw processing();
      throw e;
    }
  }
}
