import type { AppConfigService } from '../../../core/config/app-config.service.js';
import { OAuthMetadataFetcher } from './oauth-metadata-fetcher.js';
describe('OAuth元数据SSRF防护', () => {
  it('即使误把回环地址加入域名白名单，也拒绝访问内网', async () => {
    const fetcher = new OAuthMetadataFetcher({
      oauth: { cimdHosts: ['127.0.0.1'] },
    } as AppConfigService);
    await expect(
      fetcher.fetch('https://127.0.0.1/client.json'),
    ).rejects.toThrow('内网');
  });
});
