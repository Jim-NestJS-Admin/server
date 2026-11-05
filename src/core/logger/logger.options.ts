import type { DestinationStream } from 'pino';
import type { Params } from 'nestjs-pino';
import { resolveRequestId, type RequestWithId } from '../context/request-id.js';
import { reqSerializer, resSerializer, scrub } from './sanitize.js';

/**
 * 日志配置。三层保护：
 * 1. 访问日志的请求头、响应头只记白名单里的几项；URL 里的敏感查询参数先清理；
 * 2. 每条日志写出前，按字段名把任意层级（含数组）的敏感字段换成「[已隐去]」；
 * 3. 异常信息和普通字符串无法按字段名识别，业务代码禁止把密钥原文写进去（见 sanitize.ts）。
 */
export function buildLoggerOptions(opts: {
  level: string;
  pretty: boolean;
  stream?: DestinationStream;
}): Params {
  const options = {
    level: opts.level,
    genReqId: (req: unknown) => resolveRequestId(req as RequestWithId),
    serializers: { req: reqSerializer, res: resSerializer },
    formatters: {
      log: (obj: Record<string, unknown>) =>
        scrub(obj) as Record<string, unknown>,
    },
    customProps: () => ({ source: 'http' }),
    // 健康检查太频繁，不记访问日志
    autoLogging: { ignore: (req: { url?: string }) => req.url === '/health' },
    transport:
      opts.pretty && !opts.stream
        ? { target: 'pino-pretty', options: { singleLine: true } }
        : undefined,
  };
  return { pinoHttp: opts.stream ? [options, opts.stream] : options } as Params;
}
