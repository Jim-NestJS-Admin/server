import type { Request, Response } from 'express';
import {
  corsDelegate,
  endpointOfPath,
  parseOrigins,
  securityHeaders,
} from './http-security.js';

const fakeRes = () => {
  const headers: Record<string, string> = {};
  return {
    headers,
    res: {
      setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v),
      removeHeader: (k: string) => delete headers[k.toLowerCase()],
    } as unknown as Response,
  };
};

describe('安全响应头', () => {
  it('普通接口：禁止嵌入、禁止猜类型、CSP 全关', () => {
    const { headers, res } = fakeRes();
    let called = false;
    securityHeaders({ hsts: false, docsPrefix: 'docs' })(
      { path: '/admin/users' } as Request,
      res,
      () => (called = true),
    );
    expect(called).toBe(true);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['strict-transport-security']).toBeUndefined();
  });

  it('接口文档页面放宽脚本；开 HSTS 时带上', () => {
    const { headers, res } = fakeRes();
    securityHeaders({ hsts: true, docsPrefix: 'docs' })(
      { path: '/docs/swagger-ui.css' } as Request,
      res,
      () => undefined,
    );
    expect(headers['content-security-policy']).toContain("script-src 'self'");
    expect(headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers['strict-transport-security']).toContain('max-age=');
  });

  it('/docsx 这类路径不算接口文档', () => {
    const { headers, res } = fakeRes();
    securityHeaders({ hsts: false, docsPrefix: 'docs' })(
      { path: '/docsx' } as Request,
      res,
      () => undefined,
    );
    expect(headers['content-security-policy']).toContain("default-src 'none'");
  });
});

describe('按端跨域', () => {
  const run = (path: string, origin?: string) => {
    let result: unknown;
    corsDelegate({
      admin: ['https://admin.example.com'],
      web: ['https://www.example.com'],
    })(
      { path, headers: origin ? { origin } : {} } as unknown as Request,
      (_e, o) => (result = o?.origin),
    );
    return result;
  };

  it('解析逗号分隔的地址，去掉末尾斜杠和空项', () => {
    expect(parseOrigins(' https://a.com/ ,, https://b.com')).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
    expect(parseOrigins(undefined)).toEqual([]);
  });

  it('路径前缀判断端，不区分大小写', () => {
    expect(endpointOfPath('/admin/users')).toBe('admin');
    expect(endpointOfPath('/ADMIN/users')).toBe('admin');
    expect(endpointOfPath('/open/v1/x')).toBe('open');
    expect(endpointOfPath('/health')).toBeNull();
  });

  it('只放行本端白名单里的来源', () => {
    expect(run('/admin/users', 'https://admin.example.com')).toBe(
      'https://admin.example.com',
    );
    expect(run('/admin/users', 'https://www.example.com')).toBe(false);
    expect(run('/web/news', 'https://www.example.com')).toBe(
      'https://www.example.com',
    );
    expect(run('/app/x', 'https://admin.example.com')).toBe(false);
  });

  it('/open 和基础接口一律不开跨域；没带 Origin 也不回', () => {
    expect(run('/open/v1/orders', 'https://admin.example.com')).toBe(false);
    expect(run('/health', 'https://admin.example.com')).toBe(false);
    expect(run('/admin/users')).toBe(false);
  });
});
