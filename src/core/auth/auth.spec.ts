import type { AppConfigService } from '../config/app-config.service.js';
import { UnconfiguredAuthUserStore } from './auth-user.store.js';
import {
  checkPasswordPolicy,
  normalizeUsername,
  PasswordHasher,
} from './password.js';

describe('用户模块接入之前的默认实现', () => {
  const store = (isProduction: boolean, openApiExport = false) =>
    new UnconfiguredAuthUserStore({
      isProduction,
      openApiExport,
    } as AppConfigService);

  it('生产环境启动时直接拒绝；导出接口文档时不拦', () => {
    expect(() => store(true).onModuleInit()).toThrow(/生产环境不能启动/);
    expect(() => store(true, true).onModuleInit()).not.toThrow();
    expect(() => store(false).onModuleInit()).not.toThrow();
  });

  it('没有任何账号', async () => {
    await expect(store(false).findForLogin()).resolves.toBeNull();
    await expect(store(false).listOrgs()).resolves.toEqual([]);
  });
});

describe('密码', () => {
  it('规则：至少 8 位、含字母和数字、不能和账号相同', () => {
    expect(checkPasswordPolicy('abc123', 'u')).toEqual(['密码至少 8 位']);
    expect(checkPasswordPolicy('abcdefgh', 'u')).toEqual([
      '密码必须同时包含字母和数字',
    ]);
    expect(checkPasswordPolicy('Admin123', ' admin123 ')).toEqual([
      '密码不能和账号相同',
    ]);
    expect(checkPasswordPolicy('Passw0rd', 'admin')).toEqual([]);
  });

  it('账号不存在（没有哈希）时比对结果一定是 false', async () => {
    const h = await PasswordHasher.hash('Passw0rd');
    await expect(PasswordHasher.verify('Passw0rd', h)).resolves.toBe(true);
    await expect(PasswordHasher.verify('wrong', h)).resolves.toBe(false);
    await expect(
      PasswordHasher.verify('jna-dummy-password', null),
    ).resolves.toBe(false);
  });

  it('账号规范化', () => {
    expect(normalizeUsername('  AdMin ')).toBe('admin');
    expect(normalizeUsername(undefined)).toBe('');
  });
});
