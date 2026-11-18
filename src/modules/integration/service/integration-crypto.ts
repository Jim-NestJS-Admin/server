import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';

@Injectable()
export class IntegrationCrypto {
  constructor(private readonly config: AppConfigService) {}
  private key() {
    const key = this.config.integration.masterKey;
    if (!key) throw crudErrors.badRequest('尚未配置集成主密钥');
    return Buffer.from(key, 'hex');
  }
  encrypt(value: string, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data]
      .map((b) => b.toString('base64'))
      .join('.');
  }
  decrypt(value: string, context: string) {
    const [iv, tag, data] = value
      .split('.')
      .map((v) => Buffer.from(v, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString(
      'utf8',
    );
  }
}

/** 企业微信协议使用 SHA-1 签名及 AES-256-CBC，和数据库凭据加密分开。 */
export function decryptWecom(input: {
  signature: string;
  timestamp: string;
  nonce: string;
  encrypted: string;
  token: string;
  aesKey: string;
  corpId: string;
}) {
  const expected = createHash('sha1')
    .update(
      [input.token, input.timestamp, input.nonce, input.encrypted]
        .sort()
        .join(''),
    )
    .digest('hex');
  if (
    !/^[a-f0-9]{40}$/i.test(input.signature) ||
    !timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(input.signature, 'hex'),
    )
  )
    throw crudErrors.badRequest('企业微信回调签名无效');
  const key = Buffer.from(input.aesKey + '=', 'base64');
  if (key.length !== 32) throw crudErrors.badRequest('企业微信加解密配置无效');
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    const padded = Buffer.concat([
      decipher.update(Buffer.from(input.encrypted, 'base64')),
      decipher.final(),
    ]);
    const pad = padded[padded.length - 1];
    if (pad < 1 || pad > 32 || !padded.subarray(-pad).every((v) => v === pad))
      throw new Error();
    const raw = padded.subarray(0, -pad);
    if (raw.length < 20) throw new Error();
    const length = raw.readUInt32BE(16);
    if (
      20 + length > raw.length ||
      raw.subarray(20 + length).toString('utf8') !== input.corpId
    )
      throw new Error();
    return raw.subarray(20, 20 + length).toString('utf8');
  } catch {
    throw crudErrors.badRequest('企业微信回调解密失败');
  }
}
