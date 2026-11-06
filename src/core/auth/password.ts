import bcrypt from 'bcryptjs';

const COST = 12;
/** 账号不存在时也做一次同样耗时的比对，响应时间看不出账号是否存在 */
const DUMMY_HASH = bcrypt.hashSync('jna-dummy-password', COST);

/** 密码哈希和比对（bcrypt）。用户模块（T07）设置密码时用 hash，登录时用 verify */
export const PasswordHasher = {
  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, COST);
  },
  /** hash 为空（账号不存在）时比对固定哈希，结果一定是 false */
  async verify(
    plain: string,
    hash: string | null | undefined,
  ): Promise<boolean> {
    const ok = await bcrypt.compare(plain, hash || DUMMY_HASH);
    return Boolean(hash) && ok;
  },
};

/**
 * 密码规则（架构「安全基线 · 防暴力破解」）：至少 8 位，含字母和数字，不能和账号相同。
 * 返回不满足的原因，满足时返回空数组。用户模块（T07）设置和修改密码时调用。
 */
export function checkPasswordPolicy(
  password: string,
  username: string,
): string[] {
  const errors: string[] = [];
  if (password.length < 8) errors.push('密码至少 8 位');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password))
    errors.push('密码必须同时包含字母和数字');
  if (password.trim().toLowerCase() === username.trim().toLowerCase())
    errors.push('密码不能和账号相同');
  return errors;
}

/** 账号规范化：去掉首尾空格后转小写。出题、登录、失败计数、锁定都用它 */
export const normalizeUsername = (raw: string | null | undefined): string =>
  (raw ?? '').trim().toLowerCase();
