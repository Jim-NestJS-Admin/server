/**
 * 日志清洗（安全基线第 10 条）。规则按字段名判断，任意层级、数组里也生效。
 * 注意：这里只按「字段名」隐去。异常信息、普通字符串里如果写了密钥原文，无法识别，所以
 * 业务代码禁止把密码、令牌、密钥拼进日志文字或异常信息（AGENTS 规则 23）。
 */
export const CENSOR = '[已隐去]';

/** 字段名包含这些词就隐去（不区分大小写） */
const SENSITIVE_KEY =
  /pass(word|wd)?$|^pwd$|secret|token|api[-_]?key|authorization|cookie|session|id[-_]?card|credential|private[-_]?key|signature|captcha|^altcha$/i;
/** URL 查询参数里额外按敏感处理的名字（OAuth2 授权码、票据等） */
const SENSITIVE_QUERY = new Set([
  'code',
  'ticket',
  'nonce',
  'sign',
  'sig',
  'key',
]);

const MAX_DEPTH = 8;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** 深度清洗：返回新对象，不改原对象；处理循环引用和过深层级 */
export function scrub(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (depth >= MAX_DEPTH) return '[层级过深]';
  if (seen.has(value)) return '[循环引用]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1, seen));
  if (value instanceof Error) {
    return { type: value.name, message: value.message, stack: value.stack };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? CENSOR : scrub(v, depth + 1, seen);
  }
  return out;
}

/** 清理 URL 里的敏感查询参数，路径原样保留 */
export function sanitizeUrl(url: string | undefined): string | undefined {
  if (!url || !url.includes('?')) return url;
  const q = url.indexOf('?');
  const path = url.slice(0, q);
  const params = new URLSearchParams(url.slice(q + 1));
  for (const key of [...new Set(params.keys())]) {
    if (isSensitiveKey(key) || SENSITIVE_QUERY.has(key.toLowerCase()))
      params.set(key, CENSOR);
  }
  return `${path}?${params.toString()}`;
}

/** 请求头只记录这些，其余（授权、Cookie、各种密钥头）一律不记 */
const REQ_HEADERS = [
  'host',
  'user-agent',
  'content-type',
  'content-length',
  'referer',
  'accept-language',
  'x-request-id',
];
const RES_HEADERS = ['content-type', 'content-length', 'x-request-id'];

function pick(headers: unknown, keys: string[]): Record<string, unknown> {
  const h = (headers ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    keys.filter((k) => h[k] !== undefined).map((k) => [k, h[k]]),
  );
}

interface SerializedReq {
  id?: unknown;
  method?: string;
  url?: string;
  headers?: unknown;
  remoteAddress?: string;
}
interface SerializedRes {
  statusCode?: number;
  headers?: unknown;
}

export function reqSerializer(req: SerializedReq) {
  return {
    id: req.id,
    method: req.method,
    url: sanitizeUrl(req.url),
    headers: pick(req.headers, REQ_HEADERS),
    remoteAddress: req.remoteAddress,
  };
}

export function resSerializer(res: SerializedRes) {
  return {
    statusCode: res.statusCode,
    headers: pick(res.headers, RES_HEADERS),
  };
}
