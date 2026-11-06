import { HttpStatus } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';

/** 刷新令牌 Cookie（契约 auth-session.md）：只在调用 /admin/auth/* 时带上，前端读不到 */
export const REFRESH_COOKIE = 'jna_rt';
const COOKIE_PATH = '/admin/auth';

const cookieOptions = (maxAgeSeconds?: number): CookieOptions => ({
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: COOKIE_PATH,
  ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds * 1000 }),
});

export function setRefreshCookie(
  res: Response,
  token: string,
  maxAgeSeconds: number,
): void {
  res.cookie(REFRESH_COOKIE, token, cookieOptions(maxAgeSeconds));
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
}

/** 从 Cookie 头里取刷新令牌（不引入 cookie-parser，只认这一个名字） */
export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== REFRESH_COOKIE) continue;
    const value = part.slice(i + 1).trim();
    return /^[A-Za-z0-9_-]{20,200}$/.test(value) ? value : null;
  }
  return null;
}

export function readBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(h.trim());
  return m ? m[1] : null;
}

/**
 * 刷新、退出、切换组织这类会改会话、靠 Cookie 认人的接口：Origin 必须是配置里的后台地址，否则 403。
 * 浏览器跨站请求带不上 SameSite=Strict 的 Cookie，这里再加一道（架构「安全基线 · CSRF」）。
 */
export function assertAdminOrigin(req: Request, allowed: string[]): void {
  const origin = req.headers.origin?.replace(/\/+$/, '');
  if (!origin || !allowed.includes(origin))
    throw new BusinessException(
      ErrorCode.Forbidden,
      '请求来源不被允许',
      HttpStatus.FORBIDDEN,
    );
}

export const clientIp = (req: Request): string =>
  req.ip ?? req.socket.remoteAddress ?? '';

export const unauthorized = () =>
  new BusinessException(
    ErrorCode.Unauthorized,
    undefined,
    HttpStatus.UNAUTHORIZED,
  );

/** 认证通过后挂在请求上的会话编号，切换组织、退出这类接口要用 */
export interface AuthedRequest extends Request {
  jnaSession?: { sessionId: string };
}
