import { CENSOR, sanitizeUrl, scrub } from './sanitize.js';

describe('日志清洗 scrub', () => {
  it('根级、嵌套、数组里的敏感字段都隐去，普通字段保留', () => {
    const out = JSON.stringify(
      scrub({
        password: 'CANARY_ROOT',
        user: { name: 'admin', profile: { idCard: 'CANARY_IDCARD' } },
        req: {
          body: {
            password: 'CANARY_NESTED',
            items: [{ secret: 'CANARY_ARRAY' }, { apiKey: 'CANARY_KEY' }],
          },
        },
        headers: {
          Authorization: 'Bearer CANARY_AUTH',
          Cookie: 'sid=CANARY_COOKIE',
        },
        tokens: [{ accessToken: 'CANARY_AT', refresh_token: 'CANARY_RT' }],
        list: ['plain', { 'x-api-key': 'CANARY_HEADER' }],
      }),
    );
    expect(out).not.toMatch(/CANARY_/);
    expect(out).toContain(CENSOR);
    expect(out).toContain('admin');
    expect(out).toContain('plain');
  });

  it('不改原对象，处理循环引用和过深层级', () => {
    const a: Record<string, unknown> = { password: 'x' };
    a.self = a;
    const out = scrub(a) as Record<string, unknown>;
    expect(a.password).toBe('x');
    expect(out.self).toBe('[循环引用]');
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(JSON.stringify(scrub(deep))).toContain('[层级过深]');
  });
});

describe('URL 查询参数清理 sanitizeUrl', () => {
  it('敏感参数隐去，普通参数和路径保留', () => {
    const url = sanitizeUrl(
      '/admin/users?page=2&token=CANARY_T&access_token=CANARY_A&code=CANARY_C&Password=CANARY_P&kw=张三',
    );
    expect(url).not.toMatch(/CANARY_/);
    expect(url).toMatch(/^\/admin\/users\?page=2&/);
    expect(decodeURIComponent(url!)).toContain('kw=张三');
  });
  it('没有查询参数时原样返回', () => {
    expect(sanitizeUrl('/health')).toBe('/health');
    expect(sanitizeUrl(undefined)).toBeUndefined();
  });
});
