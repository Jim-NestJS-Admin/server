import { Writable } from 'node:stream';
import { pino } from 'pino';
import { REDACT_PATHS } from './logger.options.js';

describe('日志敏感字段隐去', () => {
  it('授权头、Cookie、密码、令牌、密钥不会以原文写进日志', () => {
    const lines: string[] = [];
    const out = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino(
      { redact: { paths: REDACT_PATHS, censor: '[已隐去]' } },
      out,
    );
    log.info({
      req: {
        headers: {
          authorization: 'Bearer SECRET-TOKEN',
          cookie: 'sid=SECRET-COOKIE',
        },
      },
      body: {
        username: 'admin',
        password: 'SECRET-PASS',
        refreshToken: 'SECRET-RT',
      },
      app: { secret: 'SECRET-KEY', apiKey: 'SECRET-API' },
    });
    const text = lines.join('');
    expect(text).not.toMatch(/SECRET-/);
    expect(text).toContain('[已隐去]');
    expect(text).toContain('admin');
  });
});
