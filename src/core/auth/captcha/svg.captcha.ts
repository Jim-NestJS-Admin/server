import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import svgCaptcha from 'svg-captcha';
import { RedisService } from '../../redis/redis.service.js';
import {
  CaptchaProvider,
  type CaptchaBinding,
  type CaptchaChallenge,
  type CaptchaResult,
} from './captcha.provider.js';

/** 题目有效期 2 分钟 */
const TTL_SECONDS = 120;
/** 去掉容易看混的字符 */
const IGNORE = '0oO1ilIL';
/** 难度级别：输错越多，字符越多、干扰线越多 */
const LEVELS = [
  { size: 4, noise: 2 },
  { size: 5, noise: 3 },
  { size: 6, noise: 4 },
];

/**
 * 字母数字图形验证码（svg-captcha）。答案只存在 Redis（不区分大小写），图片发给前端。
 * 校验用 GETDEL 原子取出：不管答对答错这道题都作废，并发提交同一道题只有一个能取到。
 */
@Injectable()
export class SvgCaptcha extends CaptchaProvider {
  constructor(private readonly redis: RedisService) {
    super();
  }

  private key(tenantId: string, captchaId: string) {
    return this.redis.tenantKey(tenantId, 'auth', 'captcha', captchaId);
  }

  async create(
    binding: CaptchaBinding,
    level: number,
  ): Promise<CaptchaChallenge> {
    const lv = Math.min(Math.max(level, 0), LEVELS.length - 1);
    const c = svgCaptcha.create({
      size: LEVELS[lv].size,
      noise: LEVELS[lv].noise,
      ignoreChars: IGNORE,
      color: true,
      width: 120,
      height: 40,
    });
    const captchaId = randomUUID();
    await this.redis.call((r) =>
      r.set(
        this.key(binding.tenantId, captchaId),
        JSON.stringify({
          purpose: binding.purpose,
          subject: binding.subject,
          level: lv,
          answer: c.text.toLowerCase(),
        }),
        'EX',
        TTL_SECONDS,
      ),
    );
    return {
      captchaId,
      image: `data:image/svg+xml;base64,${Buffer.from(c.data).toString('base64')}`,
    };
  }

  async verify(
    captchaId: string,
    answer: string,
    binding: CaptchaBinding,
    minLevel: number,
  ): Promise<CaptchaResult> {
    if (!/^[0-9a-f-]{36}$/.test(captchaId) || !answer)
      return { ok: false, reason: 'missing' };
    // 不同租户的题目存在不同的键下，拿别的租户的题来这里取不到
    const raw = await this.redis.call((r) =>
      r.getdel(this.key(binding.tenantId, captchaId)),
    );
    if (!raw) return { ok: false, reason: 'expired_or_used' };
    const saved = JSON.parse(raw) as {
      purpose: string;
      subject: string;
      level: number;
      answer: string;
    };
    if (saved.purpose !== binding.purpose)
      return { ok: false, reason: 'wrong_purpose' };
    if (saved.subject !== binding.subject)
      return { ok: false, reason: 'wrong_subject' };
    if (saved.level < minLevel) return { ok: false, reason: 'stale_level' };
    if (saved.answer !== answer.trim().toLowerCase())
      return { ok: false, reason: 'wrong_answer' };
    return { ok: true };
  }
}
