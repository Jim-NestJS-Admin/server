import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { createChallenge, randomInt, verifySolution } from 'altcha-lib';
import type { Payload } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { AppConfigService } from '../../config/app-config.service.js';
import { RedisService } from '../../redis/redis.service.js';
import {
  CaptchaProvider,
  type CaptchaBinding,
  type CaptchaResult,
} from './captcha.provider.js';

/** 题目有效期 2 分钟（架构「登录认证 · 接入方式」） */
const TTL_SECONDS = 120;
/** 难度级别对应的计数器范围：输错越多，浏览器要算得越久（T20 实测） */
const LEVELS = [
  { min: 50, max: 150 },
  { min: 200, max: 400 },
  { min: 600, max: 1000 },
];

/**
 * ALTCHA 实现：出题和判定都交给 altcha-lib，我们只做业务绑定和「只能用一次」。
 * 不用库自带的 NestJS 路由，因为它没法在出题时绑定用途和租户（T20 结论）。
 */
@Injectable()
export class AltchaCaptcha extends CaptchaProvider {
  constructor(
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  private get secrets() {
    const a = this.config.auth;
    return {
      hmacSignatureSecret: a.altchaHmacSecret,
      hmacKeySignatureSecret: a.altchaHmacKeySecret,
    };
  }

  async create(binding: CaptchaBinding, level: number): Promise<unknown> {
    const range = LEVELS[Math.min(Math.max(level, 0), LEVELS.length - 1)];
    return createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost: this.config.auth.altchaCost,
      counter: randomInt(range.min, range.max),
      deriveKey,
      ...this.secrets,
      expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS,
      // data 会被签名：用途、租户、对象、难度级别、题目编号都改不了
      data: {
        purpose: binding.purpose,
        tenantId: binding.tenantId,
        subject: binding.subject,
        level: String(level),
        challengeId: randomUUID(),
      },
    });
  }

  /**
   * 顺序：解码 → 库校验签名、有效期、答案 → 核对用途、租户、对象 → 难度没有落后 → 原子认领。
   * 认领放最后：没通过校验的请求不会占用别人的题。
   */
  async verify(
    raw: string,
    binding: CaptchaBinding,
    minLevel: number,
  ): Promise<CaptchaResult> {
    let payload: Payload;
    try {
      payload = JSON.parse(
        Buffer.from(raw, 'base64').toString('utf8'),
      ) as Payload;
      if (!payload?.challenge?.parameters || !payload?.solution)
        throw new Error('shape');
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    let result: Awaited<ReturnType<typeof verifySolution>>;
    try {
      result = await verifySolution({
        challenge: payload.challenge,
        solution: payload.solution,
        deriveKey,
        ...this.secrets,
      });
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (result.expired) return { ok: false, reason: 'expired' };
    if (!result.verified) return { ok: false, reason: 'invalid' };
    const data = (payload.challenge.parameters.data ?? {}) as Record<
      string,
      unknown
    >;
    if (data.purpose !== binding.purpose)
      return { ok: false, reason: 'wrong_purpose' };
    if (data.tenantId !== binding.tenantId)
      return { ok: false, reason: 'wrong_tenant' };
    if (data.subject !== binding.subject)
      return { ok: false, reason: 'wrong_subject' };
    if (Number(data.level) < minLevel)
      return { ok: false, reason: 'stale_level' };
    const id = typeof data.challengeId === 'string' ? data.challengeId : '';
    if (!id) return { ok: false, reason: 'malformed' };
    const expiresAt = Number(payload.challenge.parameters.expiresAt ?? 0);
    const ttl = Math.max(1, expiresAt - Math.floor(Date.now() / 1000)) + 5;
    const claimed = await this.redis.call((r) =>
      r.set(
        this.redis.tenantKey(binding.tenantId, 'auth', 'captcha', id),
        '1',
        'EX',
        ttl,
        'NX',
      ),
    );
    return claimed === 'OK' ? { ok: true } : { ok: false, reason: 'replayed' };
  }
}
