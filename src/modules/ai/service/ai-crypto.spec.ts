import type { AppConfigService } from '../../../core/config/app-config.service.js';
import type { RequestContext } from '../../../core/tenant/request-context.js';
import { AiCrypto } from './ai-crypto.js';
describe('AI密文绑定', () => {
  it('租户、用途或密文变化时解密失败，且相同明文使用不同随机数', () => {
    let tenantId = '101';
    const crypto = new AiCrypto(
      { ai: { masterKey: 'ab'.repeat(32) } } as AppConfigService,
      { current: () => ({ tenantId }) } as RequestContext,
    );
    const encrypted = crypto.encrypt('fixture-secret', 'api-key');
    expect(crypto.decrypt(encrypted, 'api-key')).toBe('fixture-secret');
    expect(crypto.encrypt('fixture-secret', 'api-key')).not.toBe(encrypted);
    expect(() => crypto.decrypt(encrypted, 'result')).toThrow();
    tenantId = '102';
    expect(() => crypto.decrypt(encrypted, 'api-key')).toThrow();
    tenantId = '101';
    const corrupt = Buffer.from(encrypted, 'base64');
    corrupt[corrupt.length - 1] ^= 1;
    expect(() =>
      crypto.decrypt(corrupt.toString('base64'), 'api-key'),
    ).toThrow();
  });
});
