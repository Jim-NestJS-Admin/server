import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
@Injectable()
export class AiCrypto {
  constructor(
    private readonly config: AppConfigService,
    private readonly context: RequestContext,
  ) {}
  private key() {
    const value = this.config.ai.masterKey;
    if (!value) throw crudErrors.badRequest('请先配置AI_MASTER_KEY');
    return Buffer.from(value, 'hex');
  }
  encrypt(text: string, purpose: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(
      Buffer.from(`${this.context.current().tenantId}:ai:${purpose}`),
    );
    const encrypted = Buffer.concat([
      cipher.update(text, 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64',
    );
  }
  decrypt(value: string, purpose: string) {
    const data = Buffer.from(value, 'base64'),
      cipher = createDecipheriv(
        'aes-256-gcm',
        this.key(),
        data.subarray(0, 12),
      );
    cipher.setAAD(
      Buffer.from(`${this.context.current().tenantId}:ai:${purpose}`),
    );
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      cipher.update(data.subarray(28)),
      cipher.final(),
    ]).toString('utf8');
  }
}
