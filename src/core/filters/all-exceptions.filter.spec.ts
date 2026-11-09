import type { ArgumentsHost } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

const host = () => {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(s: number) {
      out.status = s;
      return this;
    },
    json(b: unknown) {
      out.body = b;
    },
  };
  return {
    out,
    host: {
      getType: () => 'http',
      switchToHttp: () => ({ getResponse: () => res }),
    } as unknown as ArgumentsHost,
  };
};

describe('全局异常过滤：查询超时', () => {
  it('MySQL 中止的超时查询返回 503 和中文提示，不暴露 SQL', () => {
    const err = new QueryFailedError(
      'SELECT * FROM secret_table',
      [],
      Object.assign(new Error('Query execution was interrupted'), {
        code: 'ER_QUERY_TIMEOUT',
        errno: 3024,
      }),
    );
    const { out, host: h } = host();
    new AllExceptionsFilter().catch(err, h);
    expect(out.status).toBe(503);
    expect(JSON.stringify(out.body)).toContain('查询超时');
    expect(JSON.stringify(out.body)).not.toContain('secret_table');
  });

  it('其他数据库错误仍是 500 内部错误', () => {
    const err = new QueryFailedError(
      'SELECT 1',
      [],
      Object.assign(new Error('boom'), { code: 'ER_PARSE_ERROR' }),
    );
    const { out, host: h } = host();
    new AllExceptionsFilter().catch(err, h);
    expect(out.status).toBe(500);
  });
});
