import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 开放接口（/open）签名规范（T25，契约 docs/contracts/open-signature.md）。
 *
 * 请求头：X-App-Id、X-Timestamp（秒）、X-Nonce（16–64 位字母数字）、X-Signature。
 * 待签字符串（换行分隔）：
 *   方法大写 \n 路径（含查询串，原样） \n X-App-Id \n X-Timestamp \n X-Nonce \n 请求体的 SHA-256（十六进制小写，空体也算）
 * 签名 = HMAC-SHA256(应用密钥, 待签字符串)，base64url 编码。
 * 服务端：时间差不超过 5 分钟；同一个应用的 nonce 5 分钟内只能用一次（调用方用 Redis SET NX 认领）；常量时间比较。
 */
export interface OpenSignInput {
  method: string;
  path: string;
  appId: string;
  timestamp: string;
  nonce: string;
  body: string | Buffer;
}

export const OPEN_SIGNATURE_WINDOW_SECONDS = 300;

export function openStringToSign(i: OpenSignInput): string {
  const bodyHash = createHash('sha256').update(i.body).digest('hex');
  return [
    i.method.toUpperCase(),
    i.path,
    i.appId,
    i.timestamp,
    i.nonce,
    bodyHash,
  ].join('\n');
}

export function signOpenRequest(i: OpenSignInput, secret: string): string {
  return createHmac('sha256', secret)
    .update(openStringToSign(i))
    .digest('base64url');
}

export type OpenSignFailure = 'malformed' | 'expired' | 'bad_signature';

/**
 * 校验格式、时间窗口和签名（不含 nonce 防重放，那一步要 Redis，由调用方在签名通过后做）。
 */
export function verifyOpenSignature(
  i: OpenSignInput,
  signature: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: OpenSignFailure } {
  if (
    !/^\d{10}$/.test(i.timestamp) ||
    !/^[A-Za-z0-9]{16,64}$/.test(i.nonce) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(i.appId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  )
    return { ok: false, reason: 'malformed' };
  if (
    Math.abs(nowSeconds - Number(i.timestamp)) > OPEN_SIGNATURE_WINDOW_SECONDS
  )
    return { ok: false, reason: 'expired' };
  const expected = Buffer.from(signOpenRequest(i, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}
