import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import { errors } from 'oidc-provider';
import { RedisService } from '../../../core/redis/redis.service.js';
import { OAuthCrypto } from './oauth-crypto.js';
import { OAuthClientService } from './oauth-client.service.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { OAuthGrant, OAuthEvent } from '../entity/oauth.entity.js';
import { DataSource } from 'typeorm';
import { OAuthTokenStore } from './oauth-token-store.js';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
@Injectable()
export class OAuthAdapterService {
  constructor(
    private readonly redis: RedisService,
    private readonly crypto: OAuthCrypto,
    private readonly clients: OAuthClientService,
    private readonly context: RequestContext,
    private readonly repos: TenantRepositoryFactory,
    private readonly db: DataSource,
    private readonly tokens: OAuthTokenStore,
  ) {}
  key(...parts: string[]) {
    return this.redis.tenantKey('0', 'oauth', ...parts);
  }
  async revokeGrant(grantId: string, clientId?: string) {
    clientId ??= await this.tokens.clientForGrant(grantId);
    const keys = await this.redis.call((r) =>
      r.smembers(this.key('grant', grantId)),
    );
    if (!clientId && keys.length)
      for (const key of keys) {
        clientId =
          (await this.redis.call((r) => r.hget(key, 'clientId'))) ?? undefined;
        if (clientId) break;
      }
    const tenantId = clientId ? this.clients.tenantFor(clientId) : undefined;
    if (tenantId)
      await this.context.run({ tenantId }, () =>
        this.db.transaction(async (manager) => {
          const row = await this.repos
            .for(OAuthGrant)
            .query('g', manager)
            .andWhere('g.grantId=:id', { id: grantId })
            .setLock('pessimistic_write')
            .getOne();
          if (row?.active) {
            await this.repos
              .for(OAuthGrant)
              .update([row.id], { active: false }, manager);
            await this.repos.for(OAuthEvent).insert(
              {
                action: 'token-family.revoked',
                clientId: row.clientId,
                grantId: row.grantId,
              },
              manager,
            );
          }
        }),
      );
    await this.redis.call(async (r) => {
      const tx = r.multi();
      for (const key of keys) tx.del(key);
      tx.del(this.key('grant', grantId), this.key('live', grantId));
      return tx.exec();
    });
    await this.tokens.revoke(grantId);
  }
  adapter(model: string): Adapter {
    const key = (id: string) => this.key(model, hash(id));
    const read = async (id: string) => {
      const row = await this.redis.call((r) => r.hgetall(key(id)));
      if (!row.value) return undefined;
      const payload = this.crypto.decrypt<AdapterPayload>(
        row.value,
        `${model}:${id}`,
      );
      if (row.consumed) payload.consumed = Number(row.consumed);
      return payload;
    };
    return {
      find: async (id) =>
        model === 'Client'
          ? await this.clients.metadata(id)
          : ['Grant', 'RefreshToken'].includes(model)
            ? this.tokens.find(model, id)
            : read(id),
      upsert: async (id, payload, expiresIn) => {
        if (['Grant', 'RefreshToken'].includes(model)) {
          await this.tokens.upsert(
            model,
            id,
            payload,
            Math.min(expiresIn ?? 86400 * 7, 86400 * 30),
          );
          return;
        }
        if (model === 'Client') {
          await this.clients.registerDynamic(id, payload);
          return;
        }
        const ttl = Math.min(expiresIn ?? 86400 * 7, 86400 * 30),
          cipher = this.crypto.encrypt(payload, `${model}:${id}`);
        if (model === 'ReplayDetection') {
          const saved = await this.redis.call((r) =>
            r.eval(
              "if redis.call('EXISTS',KEYS[1])==1 then return 0 end redis.call('HSET',KEYS[1],'value',ARGV[1]);redis.call('EXPIRE',KEYS[1],ARGV[2]);return 1",
              1,
              key(id),
              cipher,
              ttl,
            ),
          );
          if (saved !== 1)
            throw new errors.InvalidClient('客户端签名凭据已使用');
          return;
        }
        await this.redis.call(async (r) => {
          const tx = r
            .multi()
            .hset(
              key(id),
              'value',
              cipher,
              'clientId',
              payload.clientId ?? '',
              'grantId',
              payload.grantId ?? '',
            )
            .expire(key(id), ttl);
          if (payload.grantId)
            tx.sadd(this.key('grant', payload.grantId), key(id)).expire(
              this.key('grant', payload.grantId),
              86400 * 30,
            );
          if (payload.uid)
            tx.set(this.key(model, 'uid', hash(payload.uid)), id, 'EX', ttl);
          if (payload.userCode)
            tx.set(
              this.key(model, 'user-code', hash(payload.userCode)),
              id,
              'EX',
              ttl,
            );
          return tx.exec();
        });
      },
      findByUid: async (uid) => {
        const id = await this.redis.call((r) =>
          r.get(this.key(model, 'uid', hash(uid))),
        );
        return id ? read(id) : undefined;
      },
      findByUserCode: async (code) => {
        const id = await this.redis.call((r) =>
          r.get(this.key(model, 'user-code', hash(code))),
        );
        return id ? read(id) : undefined;
      },
      destroy: async (id) => {
        if (['Grant', 'RefreshToken'].includes(model)) {
          await this.tokens.destroy(model, id);
          return;
        }
        await this.redis.call((r) => r.del(key(id)));
      },
      consume: async (id) => {
        if (['Grant', 'RefreshToken'].includes(model)) {
          if (await this.tokens.consume(model, id)) return;
          const payload = await this.tokens.find(model, id);
          if (payload?.grantId)
            await this.revokeGrant(payload.grantId, payload.clientId);
          throw new errors.InvalidGrant('一次性凭据已使用');
        }
        const result = await this.redis.call((r) =>
          r.eval(
            "if redis.call('EXISTS',KEYS[1])==0 then return 0 end if redis.call('HSETNX',KEYS[1],'consumed',ARGV[1])==0 then return 0 end return 1",
            1,
            key(id),
            String(Math.floor(Date.now() / 1000)),
          ),
        );
        if (result !== 1) {
          const payload = await read(id);
          if (payload?.grantId)
            await this.revokeGrant(payload.grantId, payload.clientId);
          throw new errors.InvalidGrant('一次性凭据已使用');
        }
      },
      revokeByGrantId: async (id) => this.revokeGrant(id),
    };
  }
}
