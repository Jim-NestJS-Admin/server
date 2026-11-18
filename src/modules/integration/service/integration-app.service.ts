import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BaseService } from '../../../core/crud/base.service.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { IdempotencyLedger } from '../../../core/security/idempotency.ledger.js';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import { IntegrationApp } from '../entity/integration.entity.js';
import { IntegrationCrypto } from './integration-crypto.js';
import type { IntegrationSaveBody } from '../dto/integration.dto.js';
import { SystemDirectory } from '../../system/service/system-directory.service.js';

@Injectable()
export class IntegrationAppService extends BaseService<IntegrationApp> {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly crypto: IntegrationCrypto,
    private readonly request: RequestContext,
    private readonly config: AppConfigService,
    private readonly ledger: IdempotencyLedger,
    private readonly db: DataSource,
    private readonly directory: SystemDirectory,
  ) {
    super();
  }
  aad(field: string) {
    return `${this.request.current().tenantId}:wecom:${field}`;
  }
  async configured() {
    return this.repos
      .for(IntegrationApp)
      .query('a')
      .addSelect(['a.secretCipher', 'a.tokenCipher', 'a.aesCipher'])
      .andWhere('a.platform = :platform AND a.enabled = :enabled', {
        platform: 'wecom',
        enabled: true,
      })
      .getOne();
  }
  credentials(app: IntegrationApp) {
    return {
      secret: this.crypto.decrypt(app.secretCipher, this.aad('secret')),
      token: this.crypto.decrypt(app.tokenCipher, this.aad('token')),
      aesKey: this.crypto.decrypt(app.aesCipher, this.aad('aes')),
    };
  }
  async save(body: IntegrationSaveBody) {
    if (
      !this.config.integration.corpId ||
      body.corpId !== this.config.integration.corpId
    )
      throw crudErrors.badRequest('企业ID必须与部署配置一致');
    let url: URL;
    try {
      url = new URL(body.adminUrl);
    } catch {
      throw crudErrors.badRequest('后台地址格式无效');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname !== '/'
    )
      throw crudErrors.badRequest('后台地址应为HTTPS根地址');
    if (!this.config.auth.adminOrigins.includes(url.origin))
      throw crudErrors.badRequest('后台地址必须属于部署配置的后台地址');
    return this.ledger.transaction(async (manager) => {
      await this.directory.assertIntegrationTargets(
        body.mountOrgId,
        body.defaultRoleId ?? null,
        manager,
      );
      const old = await this.repos
        .for(IntegrationApp)
        .query('a', manager)
        .addSelect(['a.secretCipher', 'a.tokenCipher', 'a.aesCipher'])
        .andWhere('a.platform = :platform', { platform: 'wecom' })
        .setLock('pessimistic_write')
        .getOne();
      if (old && (body.id !== old.id || body.version !== old.version))
        throw crudErrors.versionConflict();
      if (!old && body.id) throw crudErrors.notFound();
      if (!old && (!body.secret || !body.callbackToken || !body.encodingAESKey))
        throw crudErrors.badRequest(
          '首次配置必须填写应用密钥、回调Token和EncodingAESKey',
        );
      const values: Partial<IntegrationApp> = {
        platform: 'wecom',
        corpId: body.corpId,
        agentId: body.agentId,
        mountOrgId: body.mountOrgId,
        defaultRoleId: body.defaultRoleId ?? null,
        enabled: body.enabled,
        adminUrl: url.origin + '/',
        secretCipher: body.secret
          ? this.crypto.encrypt(body.secret, this.aad('secret'))
          : old!.secretCipher,
        tokenCipher: body.callbackToken
          ? this.crypto.encrypt(body.callbackToken, this.aad('token'))
          : old!.tokenCipher,
        aesCipher: body.encodingAESKey
          ? this.crypto.encrypt(body.encodingAESKey, this.aad('aes'))
          : old!.aesCipher,
      };
      if (old) {
        await this.repos.for(IntegrationApp).update([old.id], values, manager);
        return { id: old.id };
      }
      return {
        id: await this.repos.for(IntegrationApp).insert(values, manager),
      };
    });
  }
  async visible(id: string) {
    return this.select(this.db.manager, 'info')
      .andWhere('e.id = :id', { id })
      .getOne();
  }
}
