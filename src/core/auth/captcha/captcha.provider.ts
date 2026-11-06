/** 验证码用途：登录题不能拿去发短信，反过来也一样 */
export type CaptchaPurpose = 'login' | 'sms';

export interface CaptchaBinding {
  purpose: CaptchaPurpose;
  tenantId: string;
  /** 绑定的对象：登录题是规范化后的账号，短信题是手机号 */
  subject: string;
}

/** 给前端的题目：编号 + 图片（data URI） */
export interface CaptchaChallenge {
  captchaId: string;
  image: string;
}

export type CaptchaFailure =
  | 'missing'
  | 'expired_or_used'
  | 'wrong_purpose'
  | 'wrong_tenant'
  | 'wrong_subject'
  | 'stale_level'
  | 'wrong_answer';

export type CaptchaResult =
  { ok: true } | { ok: false; reason: CaptchaFailure };

/**
 * 验证码适配接口。首版是字母数字图形验证码（Jimmy 第九轮决定，和 cool-admin 一样用 svg-captcha）；
 * 以后换别的方式另写实现，登录等业务代码不用改。
 * 实现必须保证：题目绑定用途、租户、对象和难度级别，校验时原子取出并作废（答错也作废，只能用一次）。
 */
export abstract class CaptchaProvider {
  abstract create(
    binding: CaptchaBinding,
    level: number,
  ): Promise<CaptchaChallenge>;
  abstract verify(
    captchaId: string,
    answer: string,
    binding: CaptchaBinding,
    minLevel: number,
  ): Promise<CaptchaResult>;
}
