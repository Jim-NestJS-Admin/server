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

  // 默认值的精度必须和列一致：TypeORM 默认 CURRENT_TIMESTAMP(6)，MySQL 8 对 datetime(3) 直接报错
  @CreateDateColumn({
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
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

/**
 * 记录在本次请求里的状态：
 * - none：还没写；
 * - inTx：已经写进一个还没结束的事务（业务自己开事务调 recordInTx 时，事务结束前一直是它）；
 * - committed：ledger.transaction 确认事务已提交；
 * - unknown：事务体执行完了但提交时出错，不知道到底提交了没有。
 * 拦截器失败时只释放 Redis 占位，不按这里的状态宣称成功或失败：重试时以数据库记录为准。
 */
export type LedgerState = 'none' | 'inTx' | 'committed' | 'unknown';

interface Pending extends IdempotencyClaim {
  state: LedgerState;
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
    const p = this.pending();
    const before = p?.state ?? 'none';
    let bodyDone = false;
    try {
      const out = await this.dataSource.transaction(async (manager) => {
        const result = await fn(manager);
        await this.recordInTx(manager, result);
        bodyDone = true;
        return result;
      });
      if (p?.state === 'inTx') p.state = 'committed';
      return out;
    } catch (e) {
      if (p?.state === 'inTx')
        // 事务体出错 → 已回滚，记录没留下；事务体完成后才出错 → 提交结果不确定
        p.state = bodyDone ? 'unknown' : before;
      const driverCode = (e as { driverError?: { code?: string } })?.driverError
        ?.code;
      if (
        driverCode === 'ER_LOCK_DEADLOCK' ||
        driverCode === 'ER_LOCK_WAIT_TIMEOUT'
      )
        throw new BusinessException(
          ErrorCode.Conflict,
          '操作发生并发冲突，请使用原请求重试',
          409,
        );
      throw e;
    }
  }

  /**
   * 已经自己开了事务时，在事务最后调用它。之后这条记录算「在事务里」，
   * 请求成功返回时按已提交处理；事务回滚则记录随之消失。
   */
  async recordInTx(manager: EntityManager, result: unknown): Promise<void> {
    const p = this.pending();
    if (!p || p.state !== 'none') return;
    await this.insert(manager, p, result);
    p.state = 'inTx';
  }

  // ---- 下面给拦截器用 ----

  begin(claim: IdempotencyClaim): void {
    if (this.cls.isActive())
      this.cls.set<Pending>(CLS_KEY, { ...claim, state: 'none' });
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
   * 请求成功后：事务里写过（含业务自己的事务）就把结果改成最终返回的数据；
   * 没走带账本的事务（例如只调了外部接口）就在这里补写。二进制结果不保存，见拦截器说明。
   */
  async complete(result: unknown): Promise<void> {
    const p = this.pending();
    if (!p) return;
    if (p.state === 'none') {
      await this.dataSource.transaction((m) => this.insert(m, p, result));
      p.state = 'committed';
      return;
    }
    await this.dataSource
      .getRepository(IdempotencyEntity)
      .update(
        { tenantId: p.tenantId, userId: p.userId, idemKey: p.key },
        { result: result as object },
      );
    p.state = 'committed';
  }

  /** 本次请求不做幂等记录（二进制结果）：之后的事务不再写记录 */
  skip(): void {
    if (this.cls.isActive()) this.cls.set(CLS_KEY, undefined);
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
