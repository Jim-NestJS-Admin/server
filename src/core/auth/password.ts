import bcrypt from 'bcryptjs';

const COST = 12;
/** 账号不存在时也做一次同样耗时的比对，响应时间看不出账号是否存在 */
const DUMMY_HASH = bcrypt.hashSync('jna-dummy-password', COST);

/**
 * 密码最多 72 字节（UTF-8）。bcrypt 只看前 72 字节，超出部分会被静默忽略，
 * 前 72 字节相同的两个密码会被当成同一个。所以超长一律拒绝，不截断。中文一个字 3 字节，约 24 个字。
 */
export const PASSWORD_MAX_BYTES = 72;

export const passwordBytes = (plain: string): number =>
  Buffer.byteLength(plain, 'utf8');

/** 密码哈希和比对（bcrypt）。用户模块（T07）设置密码时用 hash，登录时用 verify */
export const PasswordHasher = {
  /** 超过 72 字节直接报错；设置密码前先用 checkPasswordPolicy 给用户友好提示 */
  async hash(plain: string): Promise<string> {
    if (passwordBytes(plain) > PASSWORD_MAX_BYTES)
      throw new Error(`密码超过 ${PASSWORD_MAX_BYTES} 字节，不能哈希`);
    return bcrypt.hash(plain, COST);
  },
  /** hash 为空（账号不存在）或密码超过 72 字节：照样比对一次固定哈希（耗时一样），结果一定是 false */
  async verify(
    plain: string,
    hash: string | null | undefined,
  ): Promise<boolean> {
    const tooLong = passwordBytes(plain) > PASSWORD_MAX_BYTES;
    const ok = await bcrypt.compare(
      tooLong ? 'jna-too-long' : plain,
      hash && !tooLong ? hash : DUMMY_HASH,
    );
    return Boolean(hash) && !tooLong && ok;
  },
};

/**
 * 密码规则（架构「安全基线 · 防暴力破解」）：至少 8 位，最多 72 字节，含字母和数字，不能和账号相同。
 * 返回不满足的原因，满足时返回空数组。用户模块（T07）设置和修改密码时调用。
 */
export function checkPasswordPolicy(
  password: string,
  username: string,
): string[] {
  const errors: string[] = [];
  if (password.length < 8) errors.push('密码至少 8 位');
  if (passwordBytes(password) > PASSWORD_MAX_BYTES)
    errors.push('密码太长：最多 72 字节（英文数字 72 个，中文约 24 个字）');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password))
    errors.push('密码必须同时包含字母和数字');
  if (password.trim().toLowerCase() === username.trim().toLowerCase())
    errors.push('密码不能和账号相同');
  return errors;
}

/** 账号规范化：去掉首尾空格后转小写。出题、登录、失败计数、锁定都用它 */
export const normalizeUsername = (raw: string | null | undefined): string =>
  (raw ?? '').trim().toLowerCase();
