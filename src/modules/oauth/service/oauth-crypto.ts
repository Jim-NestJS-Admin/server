import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppConfigService } from '../../../core/config/app-config.service.js';
@Injectable()
export class OAuthCrypto {
  constructor(private readonly config: AppConfigService) {}
  encrypt(value: unknown, aad: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv(
        'aes-256-gcm',
        Buffer.from(this.config.oauth.masterKey!, 'hex'),
        iv,
      );
    cipher.setAAD(Buffer.from(aad));
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');
  }
  decrypt<T>(raw: string, aad: string): T {
    const value = Buffer.from(raw, 'base64'),
      cipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(this.config.oauth.masterKey!, 'hex'),
        value.subarray(0, 12),
      );
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(value.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        cipher.update(value.subarray(12, -16)),
        cipher.final(),
      ]).toString(),
    ) as T;
  }
}
