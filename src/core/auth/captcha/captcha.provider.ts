/** 人机验证用途：登录题不能拿去发短信，反过来也一样 */
export type CaptchaPurpose = 'login' | 'sms';

export interface CaptchaBinding {
  purpose: CaptchaPurpose;
  tenantId: string;
  /** 绑定的对象：登录题是规范化后的账号，短信题是手机号 */
  subject: string;
}

export type CaptchaFailure =
  | 'malformed'
  | 'invalid'
  | 'expired'
  | 'wrong_purpose'
  | 'wrong_tenant'
  | 'wrong_subject'
  | 'stale_level'
  | 'replayed';

export type CaptchaResult =
  { ok: true } | { ok: false; reason: CaptchaFailure };

/**
 * 人机验证适配接口（架构「登录认证 · 可替换」）。首版只有 ALTCHA；
 * 以后换拖动拼图或云验证码时另写一个实现，登录等业务代码不用改。
 * 实现必须保证：题目绑定用途、租户、对象和难度级别，校验通过后原子地作废（只能用一次）。
 */
export abstract class CaptchaProvider {
  /** 出题，返回给前端组件的原始题目对象 */
  abstract create(binding: CaptchaBinding, level: number): Promise<unknown>;
  /** 校验：签名、有效期、答案、绑定一致、难度不低于 minLevel，最后原子认领 */
  abstract verify(
    payload: string,
    binding: CaptchaBinding,
    minLevel: number,
  ): Promise<CaptchaResult>;
}
