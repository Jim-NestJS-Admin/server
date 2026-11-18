import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { IntegrationInbox } from '../entity/integration.entity.js';
import { IntegrationAppService } from './integration-app.service.js';
import { IntegrationCrypto, decryptWecom } from './integration-crypto.js';

/** 只读取协议的标量元素，拒绝DTD/实体声明和重复元素；不解释任意XML。 */
export function callbackField(xml: string, name: string): string {
  if (xml.length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw crudErrors.badRequest('回调XML无效');
  const values = [
    ...xml.matchAll(
      new RegExp(
        `<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${name}>`,
        'g',
      ),
    ),
  ];
  if (values.length > 1) throw crudErrors.badRequest('回调XML元素重复');
  return values[0]?.[1] ?? values[0]?.[2] ?? '';
}
export interface CallbackSignature {
  msg_signature: string;
  timestamp: string;
  nonce: string;
}

@Injectable()
export class IntegrationCallbackService {
  constructor(
    private readonly apps: IntegrationAppService,
    private readonly crypto: IntegrationCrypto,
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
    private readonly db: DataSource,
  ) {}
  async decode(query: CallbackSignature, encrypted: string) {
    if (
      !/^[0-9]{10,11}$/.test(query.timestamp) ||
      Math.abs(Date.now() / 1000 - Number(query.timestamp)) > 300 ||
      !query.nonce ||
      query.nonce.length > 200
    )
      throw crudErrors.badRequest('企业微信回调已过期或参数无效');
    const app = await this.apps.configured();
    if (!app) throw crudErrors.badRequest('企业微信未启用');
    const credentials = this.apps.credentials(app);
    const plaintext = decryptWecom({
      signature: query.msg_signature,
      timestamp: query.timestamp,
      nonce: query.nonce,
      encrypted,
      token: credentials.token,
      aesKey: credentials.aesKey,
      corpId: app.corpId,
    });
    return { app, plaintext };
  }
  async receive(query: CallbackSignature, xml: string) {
    const { app, plaintext } = await this.decode(
      query,
      callbackField(xml, 'Encrypt'),
    );
    const to = callbackField(plaintext, 'ToUserName');
    if (to !== app.corpId)
      throw crudErrors.badRequest('企业微信回调企业不匹配');
    const eventKey = createHash('sha256').update(plaintext).digest('hex');
    await this.db
      .transaction(async (manager) => {
        const existing = await this.repos
          .for(IntegrationInbox)
          .query('i', manager)
          .andWhere('i.eventKey = :eventKey', { eventKey })
          .getOne();
        if (!existing)
          await this.repos.for(IntegrationInbox).insert(
            {
              appId: app.id,
              eventKey,
              status: 'pending',
              attempts: 0,
              nextAttemptAt: new Date(),
              payloadCipher: this.crypto.encrypt(
                plaintext,
                `${this.context.current().tenantId}:inbox:${eventKey}`,
              ),
            },
            manager,
          );
      })
      .catch((error) => {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('driverError' in error) ||
          (error as { driverError?: { code?: string } }).driverError?.code !==
            'ER_DUP_ENTRY'
        )
          throw error;
      });
    return 'success';
  }
}
