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

  it('超过 72 字节一律拒绝，不截断（bcrypt 只看前 72 字节）', async () => {
    const a = 'Passw0rd' + 'a'.repeat(64) + 'x'; // 73 字节
    const b = 'Passw0rd' + 'a'.repeat(64) + 'y';
    expect(checkPasswordPolicy(a, 'u')).toContain(
      '密码太长：最多 72 字节（英文数字 72 个，中文约 24 个字）',
    );
    await expect(PasswordHasher.hash(a)).rejects.toThrow(/72 字节/);
    const at72 = await PasswordHasher.hash(a.slice(0, 72));
    await expect(PasswordHasher.verify(a.slice(0, 72), at72)).resolves.toBe(
      true,
    );
    // 前 72 字节相同、第 73 字节不同：都不能通过
    await expect(PasswordHasher.verify(a, at72)).resolves.toBe(false);
    await expect(PasswordHasher.verify(b, at72)).resolves.toBe(false);
  });

  it('按 UTF-8 字节算，不按字数：中文 23 个字加 a1（71 字节）可以，24 个字（74 字节）超了', async () => {
    const zh24 = '密'.repeat(22) + 'a1';
    expect(Buffer.byteLength(zh24)).toBe(68);
    expect(checkPasswordPolicy('密'.repeat(23) + 'a1', 'u')).toEqual([]);
    expect(checkPasswordPolicy('密'.repeat(24) + 'a1', 'u')).toHaveLength(1);
    const h = await PasswordHasher.hash('密'.repeat(23) + 'a1');
    await expect(
      PasswordHasher.verify('密'.repeat(23) + 'a1', h),
    ).resolves.toBe(true);
    await expect(
      PasswordHasher.verify('密'.repeat(23) + 'a1x', h),
    ).resolves.toBe(false);
  });
});
