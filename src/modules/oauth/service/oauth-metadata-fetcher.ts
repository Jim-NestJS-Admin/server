import { Injectable } from '@nestjs/common';
import { request as httpsRequest } from 'node:https';
import { assertPublicUrl } from '../../../core/security/ssrf.js';
import { AppConfigService } from '../../../core/config/app-config.service.js';
@Injectable()
export class OAuthMetadataFetcher {
  constructor(private readonly config: AppConfigService) {}
  async fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const checked = await assertPublicUrl(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (
      checked.url.protocol !== 'https:' ||
      !this.config.oauth.cimdHosts.includes(checked.url.hostname.toLowerCase())
    )
      throw new Error('外部元数据地址不受信任');
    return new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        checked.url,
        {
          method: 'GET',
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          lookup: (_host, _options, done) =>
            done(null, checked.address, checked.family),
          timeout: 5000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65536) {
              request.destroy();
              reject(new Error('元数据过大'));
            } else chunks.push(chunk);
          });
          response.on('end', () =>
            resolve(
              new Response(Buffer.concat(chunks).toString('utf8'), {
                status: response.statusCode ?? 502,
                headers: {
                  'content-type': String(
                    response.headers['content-type'] ?? 'application/json',
                  ),
                },
              }),
            ),
          );
        },
      );
      request.on('timeout', () => request.destroy(new Error('元数据请求超时')));
      request.on('error', () => reject(new Error('元数据请求失败')));
      request.end();
    });
  }
}
