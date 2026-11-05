import type { Params } from 'nestjs-pino';
import { resolveRequestId, type RequestWithId } from '../context/request-id.js';

/** 日志里一律隐去的字段（安全基线第 10 条）。新增敏感字段时加在这里 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.oldPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.apiKey',
  '*.idCard',
];

export function buildLoggerOptions(opts: {
  level: string;
  pretty: boolean;
}): Params {
  return {
    pinoHttp: {
      level: opts.level,
      genReqId: (req) => resolveRequestId(req as RequestWithId),
      redact: { paths: REDACT_PATHS, censor: '[已隐去]' },
      customProps: () => ({ source: 'http' }),
      // 健康检查太频繁，不记访问日志
      autoLogging: { ignore: (req) => req.url === '/health' },
      transport: opts.pretty
        ? { target: 'pino-pretty', options: { singleLine: true } }
        : undefined,
    },
  };
}
