import 'reflect-metadata';
import { PickType } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  SystemTenant,
  TenantPackage,
  TenantQuotas,
  normalizeTenantDomain,
} from './tenant.entity.js';
class PackageInput extends PickType(TenantPackage, [
  'code',
  'name',
  'enabled',
  'menuIds',
  'quotas',
  'remark',
] as const) {}

describe('平台租户目录入参', () => {
  it.each([
    ['EXAMPLE.COM:80', 'example.com'],
    ['a.example.com:8851', 'a.example.com:8851'],
    ['example.com:443', 'example.com:443'],
  ])('域名规范化 %s', (input, output) => {
    expect(normalizeTenantDomain(input)).toBe(output);
  });
  it.each([
    'http://example.com',
    'a/b',
    'u@example.com',
    'localhost',
    '127.0.0.1:8851',
    '[::1]',
    '0.0.0.0',
    'example.com?x',
    'example.com#x',
    'bad_name.test',
    '-bad.example',
    'good.test:99999',
  ])('拒绝无效或本机域名 %s', (domain) => {
    expect(normalizeTenantDomain(domain)).toBeNull();
  });
  it('归一化后校验重复域名，保留平台编码', async () => {
    const tenant = plainToInstance(SystemTenant, {
      code: 'platform',
      name: '租户',
      packageId: '1',
      domains: ['EXAMPLE.COM', 'example.com:80'],
    });
    const errors = await validate(tenant);
    expect(errors.map((error) => error.property)).toContain('code');
    expect(errors.map((error) => error.property)).toContain('domains');
  });
  it('配额仅接受非负整数或null，嵌套未知字段拒绝', async () => {
    const pack = plainToInstance(PackageInput, {
      code: 'basic',
      name: '基础版',
      quotas: { maxUsers: -1, storageMb: 1.5, shell: 'echo unsafe' },
    });
    const errors = await validate(pack, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.some((error) => error.property === 'quotas')).toBe(true);
    expect(
      await validate(
        plainToInstance(PackageInput, {
          code: 'all',
          name: '全部',
          quotas: new TenantQuotas(),
        }),
        { whitelist: true, forbidNonWhitelisted: true },
      ),
    ).toEqual([]);
  });
});
