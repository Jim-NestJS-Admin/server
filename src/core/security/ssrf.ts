import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * 访问外部地址前的 SSRF 检查（T25，架构「安全基线 · SSRF」）。用在 Webhook、抓取图片、第三方回调这类
 * 「服务器按用户给的地址发请求」的地方：
 * - 只允许 http / https；
 * - 解析出的**全部**地址都不能是内网、本机、链路本地、保留地址（含 IPv4 映射的 IPv6）；
 * - 返回检查过的地址，调用方必须用这个地址连接（Host 头用原域名），不能再解析一次（防 DNS 重绑定）；
 * - 默认不跟随跳转；要跟随时每一跳都重新调用本函数。
 */
export async function assertPublicUrl(
  raw: string,
): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('地址格式不对');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new SsrfError('只允许 http / https 地址');
  if (url.username || url.password) throw new SsrfError('地址里不能带账号密码');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) as 4 | 6 }]
    : ((await lookup(host, { all: true, verbatim: true }).catch(() => {
        throw new SsrfError('域名解析失败');
      })) as { address: string; family: 4 | 6 }[]);
  if (addresses.length === 0) throw new SsrfError('域名解析失败');
  for (const a of addresses)
    if (isPrivateAddress(a.address))
      throw new SsrfError('不允许访问内网或本机地址');
  return { url, address: addresses[0].address, family: addresses[0].family };
}

export class SsrfError extends Error {}

/** 内网、本机、链路本地、保留、组播地址 */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb') ||
    v6.startsWith('ff')
  );
}
