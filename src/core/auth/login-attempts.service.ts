import { HttpStatus, Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';
import { RedisService } from '../redis/redis.service.js';

/** 被锁定：429 / 4029，data 带 retryAfterSeconds，控制器负责加 Retry-After 响应头 */
export class LoginLockedException extends BusinessException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      ErrorCode.TooManyRequests,
      `输错次数过多，请 ${Math.ceil(retryAfterSeconds / 60)} 分钟后再试`,
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfterSeconds },
    );
  }
}

/**
 * 登录失败计数、锁定和人机验证难度（架构「安全基线 · 防暴力破解」）。
 * 按「账号」和「IP」两个维度计数：账号不存在也照样计数和锁定，看不出账号是否存在；
 * IP 维度防止一个 IP 轮流试很多账号。计数在锁定时长内有效，每次失败重新计时。
 */
@Injectable()
export class LoginAttempts {
  constructor(
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
  ) {}

  private keys(tenantId: string, username: string, ip: string) {
    return {
      account: this.redis.tenantKey(tenantId, 'auth', 'fail', 'acct', username),
      ip: this.redis.tenantKey(tenantId, 'auth', 'fail', 'ip', ip),
    };
  }

  private async counts(tenantId: string, username: string, ip: string) {
    const k = this.keys(tenantId, username, ip);
    const [a, i] = await this.redis.call((r) => r.mget(k.account, k.ip));
    return { account: Number(a ?? 0), ip: Number(i ?? 0), keys: k };
  }

  /** 已锁定就抛 429。放在人机验证和密码校验之前 */
  async assertNotLocked(
    tenantId: string,
    username: string,
    ip: string,
  ): Promise<void> {
    const { lockMaxFails, lockIpMaxFails } = this.config.auth;
    const c = await this.counts(tenantId, username, ip);
    const locked = [
      c.account >= lockMaxFails ? c.keys.account : null,
      c.ip >= lockIpMaxFails ? c.keys.ip : null,
    ].filter((k): k is string => k !== null);
    if (locked.length === 0) return;
    const ttls = await this.redis.call((r) =>
      Promise.all(locked.map((k) => r.ttl(k))),
    );
    throw new LoginLockedException(Math.max(1, ...ttls));
  }

  /**
   * 人机验证难度：同一账号或同一 IP 输错越多，难度越高。
   * 账号输错 1 次升到 1 级、3 次升到 2 级；IP 输错 5 次升到 1 级、10 次升到 2 级。
   */
  async level(tenantId: string, username: string, ip: string): Promise<number> {
    const c = await this.counts(tenantId, username, ip);
    const byAccount = c.account >= 3 ? 2 : c.account >= 1 ? 1 : 0;
    const byIp = c.ip >= 10 ? 2 : c.ip >= 5 ? 1 : 0;
    return Math.max(byAccount, byIp);
  }

  /** 这次登录要不要人机验证：默认每次都要；配置成 after-failure 时，账号或 IP 输错过才要 */
  async captchaRequired(
    tenantId: string,
    username: string,
    ip: string,
  ): Promise<boolean> {
    if (this.config.auth.captchaMode === 'always') return true;
    const c = await this.counts(tenantId, username, ip);
    return c.account > 0 || c.ip > 0;
  }

  async recordFailure(
    tenantId: string,
    username: string,
    ip: string,
  ): Promise<void> {
    const k = this.keys(tenantId, username, ip);
    const ttl = this.config.auth.lockSeconds;
    await this.redis.call((r) =>
      r
        .multi()
        .incr(k.account)
        .expire(k.account, ttl)
        .incr(k.ip)
        .expire(k.ip, ttl)
        .exec(),
    );
  }

  /** 登录成功：清掉这个账号的失败计数（IP 的不清，避免用一个自己的账号洗掉撞库记录） */
  async reset(tenantId: string, username: string): Promise<void> {
    const k = this.keys(tenantId, username, '');
    await this.redis.call((r) => r.del(k.account));
  }
}
