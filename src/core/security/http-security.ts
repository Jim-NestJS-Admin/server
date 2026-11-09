import type { NextFunction, Request, Response } from 'express';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';
import type { EndpointKind } from '../tenant/request-context.js';
import { ENDPOINT_PREFIX } from '../endpoint/endpoint.decorators.js';

/**
 * 安全响应头（架构「安全基线」第 10 条）。Nginx 也会加一遍，这里保证直连后端时同样生效。
 * - 禁止被别的网站嵌入（X-Frame-Options + CSP frame-ancestors）
 * - 禁止浏览器猜测文件类型（nosniff）
 * - 接口只返回数据，CSP 一律 default-src 'none'；接口文档页面要跑脚本，单独放宽
 * - 生产环境开 HSTS（全站 HTTPS）
 */
export function securityHeaders(opts: { hsts: boolean; docsPrefix?: string }) {
  const docs = opts.docsPrefix
    ? `/${opts.docsPrefix.replace(/^\/+/, '')}`
    : null;
  return (req: Request, res: Response, next: NextFunction): void => {
    res.removeHeader('X-Powered-By');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=()',
    );
    const isDocs =
      docs !== null &&
      (req.path === docs || req.path.toLowerCase().startsWith(`${docs}/`));
    res.setHeader(
      'Content-Security-Policy',
      isDocs
        ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
        : "default-src 'none'; frame-ancestors 'none'",
    );
    if (opts.hsts)
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      );
    next();
  };
}

/** 按端配置的跨域白名单。/open 是服务器之间调用，不开跨域；基础接口（/health 等）也不开 */
export type CorsOrigins = Partial<Record<EndpointKind, string[]>>;

export const parseOrigins = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

/** 根据请求路径判断属于哪个端；路由不区分大小写，这里也转小写 */
export function endpointOfPath(path: string): EndpointKind | null {
  const first = path.replace(/^\/+/, '').split('/')[0]?.toLowerCase();
  for (const [kind, prefix] of Object.entries(ENDPOINT_PREFIX))
    if (prefix === first) return kind as EndpointKind;
  return null;
}

/**
 * 跨域只允许配置里列出的前端域名，按端分别配置（后台、网站、APP 各自列出）。
 * 不在白名单的来源不回 Access-Control-Allow-Origin，浏览器自己拦下；不报错，避免影响同源请求。
 */
export function corsDelegate(origins: CorsOrigins) {
  return (
    req: Request,
    cb: (err: Error | null, options?: CorsOptions) => void,
  ): void => {
    const kind = endpointOfPath(req.path ?? req.url ?? '');
    const list = kind && kind !== 'open' ? (origins[kind] ?? []) : [];
    const origin = req.headers.origin?.replace(/\/+$/, '');
    const allowed = !!origin && list.includes(origin);
    cb(null, {
      origin: allowed ? origin : false,
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'Idempotency-Key',
        'X-Request-Id',
      ],
      exposedHeaders: ['X-Request-Id', 'Retry-After', 'Content-Disposition'],
      maxAge: 600,
    });
  };
}
