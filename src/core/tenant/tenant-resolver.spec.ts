import type { Request } from 'express';
import { TenantResolver } from './tenant-resolver.js';
import { TenantSource, type TenantInfo } from './tenant-source.js';
import { UNRESOLVED_TENANT_ID } from './tenant.constants.js';

const t = (id: string, code: string, enabled = true): TenantInfo => ({
  id,
  code,
  name: code,
  enabled,
  packageId: id === '0' ? null : '1',
});
const all = [
  t('0', 'platform'),
  t('1', 'default'),
  t('5', 'acme'),
  t('6', 'stopped', false),
];
const domains: Record<string, TenantInfo> = {
  'acme.example.com': all[2],
  'stopped.example.com': all[3],
};

class Source extends TenantSource {
  async byDomain(host: string) {
    return domains[host] ?? null;
  }
  async byCode(code: string) {
    return all.find((x) => x.code === code) ?? null;
  }
  async byId(id: string) {
    return all.find((x) => x.id === id) ?? null;
  }
  async packageMenuIds() {
    return null;
  }
}

const req = (host: string, code?: string) =>
  ({
    host,
    get: () => host,
    headers: code === undefined ? {} : { 'x-tenant-code': code },
  }) as unknown as Request;

describe('后台租户识别 TenantResolver', () => {
  const r = new TenantResolver(new Source());

  it('域名绑定了租户就按域名；带了不同的编码视为找不到', async () => {
    expect(await r.anonymous(req('acme.example.com'))).toBe('5');
    expect(await r.anonymous(req('ACME.example.com', 'acme'))).toBe('5');
    expect(await r.anonymous(req('acme.example.com', 'default'))).toBe(
      UNRESOLVED_TENANT_ID,
    );
  });

  it('共用域名按租户编码；不带编码是默认租户；平台编码 platform', async () => {
    expect(await r.anonymous(req('localhost:8851', 'acme'))).toBe('5');
    expect(await r.anonymous(req('localhost:8851', ' Platform '))).toBe('0');
    expect(await r.anonymous(req('localhost:8851'))).toBe('1');
  });

  it('编码不存在、格式不对、租户停用都落到不存在的租户（登录按密码错误失败）', async () => {
    for (const code of ['nobody', 'x', '../1', 'stopped'])
      expect(await r.anonymous(req('localhost:8851', code))).toBe(
        UNRESOLVED_TENANT_ID,
      );
    expect(await r.anonymous(req('stopped.example.com'))).toBe(
      UNRESOLVED_TENANT_ID,
    );
  });

  it('不带编码时默认租户也要核对可用：默认租户停用后落到不存在的租户', async () => {
    all[1].enabled = false;
    try {
      expect(await r.anonymous(req('localhost:8851'))).toBe(
        UNRESOLVED_TENANT_ID,
      );
    } finally {
      all[1].enabled = true;
    }
  });

  it('已登录请求只认令牌租户：租户停用、域名绑定了别的租户都不放行', async () => {
    expect(await r.tokenAllowed(req('localhost:8851'), '5')).toBe(true);
    expect(await r.tokenAllowed(req('acme.example.com'), '5')).toBe(true);
    expect(await r.tokenAllowed(req('acme.example.com'), '1')).toBe(false);
    expect(await r.tokenAllowed(req('localhost:8851'), '6')).toBe(false);
    expect(await r.tokenAllowed(req('localhost:8851'), '99')).toBe(false);
  });

  it('登录页提示：绑定了可用租户返回租户名称，否则要填编码', async () => {
    expect(await r.hint(req('acme.example.com'))).toEqual({
      mode: 'domain',
      tenant: { code: 'acme', name: 'acme' },
    });
    expect(await r.hint(req('stopped.example.com'))).toEqual({ mode: 'code' });
    expect(await r.hint(req('localhost:8851'))).toEqual({ mode: 'code' });
  });
});
