import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';
/** 只接受这种格式的外部请求 ID，防止日志注入和超长值 */
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

export type RequestWithId = IncomingMessage & { id?: string };

/** 请求 ID：来自上游（Nginx）的合法值沿用，否则新生成；写回响应头，日志和 CLS 都用它 */
export function resolveRequestId(req: RequestWithId): string {
  if (req.id) return req.id;
  const incoming = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  req.id = value && SAFE_ID.test(value) ? value : randomUUID();
  return req.id;
}

export function requestIdMiddleware(
  req: RequestWithId,
  res: ServerResponse,
  next: () => void,
): void {
  res.setHeader(REQUEST_ID_HEADER, resolveRequestId(req));
  next();
}
