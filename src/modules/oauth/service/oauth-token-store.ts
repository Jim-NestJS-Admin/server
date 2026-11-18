import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import type { AdapterPayload } from 'oidc-provider';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { OAuthToken } from '../entity/oauth.entity.js';
import { OAuthCrypto } from './oauth-crypto.js';
/** 签发方持有的协议状态统一存平台命名空间；业务授权归属仍由tenant/client/grant绑定校验。 */
@Injectable()
export class OAuthTokenStore {
  constructor(
    private readonly context: RequestContext,
    private readonly repos: TenantRepositoryFactory,
    private readonly db: DataSource,
    private readonly crypto: OAuthCrypto,
  ) {}
  private hash(id: string) {
    return createHash('sha256').update(id).digest('hex');
  }
  private query(model: string, id: string, manager?: EntityManager) {
    return this.repos
      .for(OAuthToken)
      .query('t', manager)
      .andWhere('t.model=:model AND t.lookupHash=:hash', {
        model,
        hash: this.hash(id),
      });
  }
  async find(model: string, id: string) {
    return this.context.run({ tenantId: '0' }, async () => {
      const row = await this.query(model, id)
        .addSelect('t.valueCipher')
        .getOne();
      if (!row || row.expiresAt.getTime() <= Date.now()) return undefined;
      const payload = this.crypto.decrypt<AdapterPayload>(
        row.valueCipher,
        `${model}:${id}`,
      );
      if (row.consumedAt)
        payload.consumed = Math.floor(row.consumedAt.getTime() / 1000);
      return payload;
    });
  }
  async upsert(
    model: string,
    id: string,
    payload: AdapterPayload,
    ttl: number,
  ) {
    return this.context.run({ tenantId: '0' }, () =>
      this.db.transaction(async (manager) => {
        const old = await this.query(model, id, manager)
          .setLock('pessimistic_write')
          .getOne();
        const values = {
          model,
          lookupHash: this.hash(id),
          clientId: payload.clientId ?? '',
          grantId: model === 'Grant' ? id : (payload.grantId ?? null),
          valueCipher: this.crypto.encrypt(payload, `${model}:${id}`),
          expiresAt: new Date(Date.now() + ttl * 1000),
        };
        if (old)
          await this.repos.for(OAuthToken).update([old.id], values, manager);
        else
          await this.repos
            .for(OAuthToken)
            .insert({ ...values, consumedAt: null }, manager);
      }),
    );
  }
  async consume(model: string, id: string) {
    return this.context.run({ tenantId: '0' }, () =>
      this.db.transaction(async (manager) => {
        const row = await this.query(model, id, manager)
          .setLock('pessimistic_write')
          .getOne();
        if (!row || row.consumedAt) return false;
        await this.repos
          .for(OAuthToken)
          .update([row.id], { consumedAt: new Date() }, manager);
        return true;
      }),
    );
  }
  async destroy(model: string, id: string) {
    await this.context.run({ tenantId: '0' }, async () => {
      const row = await this.query(model, id).getOne();
      if (row) await this.repos.for(OAuthToken).remove([row.id]);
    });
  }
  async clientForGrant(id: string) {
    return this.context.run({ tenantId: '0' }, async () => {
      const row = await this.repos
        .for(OAuthToken)
        .query('t')
        .andWhere('t.grantId=:id', { id })
        .getOne();
      return row?.clientId;
    });
  }
  async revoke(id: string) {
    await this.context.run({ tenantId: '0' }, async () => {
      const rows = await this.repos
        .for(OAuthToken)
        .query('t')
        .andWhere('t.grantId=:id', { id })
        .getMany();
      await this.repos.for(OAuthToken).remove(rows.map((row) => row.id));
    });
  }
}
