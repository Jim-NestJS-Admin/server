import type { AppConfigService } from '../../../core/config/app-config.service.js';
import { OAuthCrypto } from './oauth-crypto.js';
describe('OAuth协议状态加密', () => {
  it('密文绑定模型和对象ID，篡改拒绝，相同内容随机加密', () => {
    const crypto = new OAuthCrypto({
        oauth: { masterKey: 'ab'.repeat(32) },
      } as AppConfigService),
      value = { clientId: '101.client', scope: 'ai:read' };
    const encrypted = crypto.encrypt(value, 'AuthorizationCode:fixture');
    expect(crypto.decrypt(encrypted, 'AuthorizationCode:fixture')).toEqual(
      value,
    );
    expect(crypto.encrypt(value, 'AuthorizationCode:fixture')).not.toBe(
      encrypted,
    );
    expect(() => crypto.decrypt(encrypted, 'RefreshToken:fixture')).toThrow();
    const bytes = Buffer.from(encrypted, 'base64');
    bytes[bytes.length - 1] ^= 1;
    expect(() =>
      crypto.decrypt(bytes.toString('base64'), 'AuthorizationCode:fixture'),
    ).toThrow();
  });
});
