import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import { BaseService } from '../../../core/crud/base.service.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { IdempotencyLedger } from '../../../core/security/idempotency.ledger.js';
import { TenantQuotaService } from '../../tenant/service/tenant-quota.service.js';
import { AiSetting, AiTemplate } from '../entity/ai.entity.js';
import type {
  AiConfigSaveBody,
  AiConfigResult,
  AiTemplateSaveBody,
} from '../dto/ai.dto.js';
import { AiCrypto } from './ai-crypto.js';
import { validateTemplate } from './ai-template.js';

@Injectable()
export class AiSettingsService {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
    private readonly config: AppConfigService,
    private readonly crypto: AiCrypto,
    private readonly ledger: IdempotencyLedger,
    private readonly quota: TenantQuotaService,
  ) {}
  async current(manager?: EntityManager, lock = false) {
    const q = this.repos
      .for(AiSetting)
      .query('s', manager)
      .addSelect('s.keyCipher')
      .andWhere('s.code = :code', { code: 'default' });
    if (lock) q.setLock('pessimistic_write');
    return q.getOne();
  }
  async read(): Promise<AiConfigResult> {
    const row = await this.current();
    return {
      enabled: row?.enabled ?? false,
      model: row?.model ?? this.config.ai.model,
      maxOutputTokens: row?.maxOutputTokens ?? this.config.ai.maxOutputTokens,
      version: row?.version ?? 0,
      hasTenantKey: !!row?.keyCipher,
      hasPlatformKey: !!this.config.ai.apiKey,
      encryptionReady: !!this.config.ai.masterKey,
    };
  }
  async credentials() {
    const row = await this.current();
    const apiKey = row?.keyCipher
      ? this.crypto.decrypt(row.keyCipher, 'api-key')
      : this.config.ai.apiKey;
    if (!row?.enabled || !apiKey || !row.model || !this.config.ai.masterKey)
      throw crudErrors.badRequest('AI未启用或密钥/模型未配置');
    return {
      apiKey,
      model: row.model,
      maxOutputTokens: Math.min(
        row.maxOutputTokens,
        this.config.ai.maxOutputTokens,
      ),
      timeoutMs: this.config.ai.timeoutMs,
    };
  }
  async save(body: AiConfigSaveBody) {
    if (body.apiKey && body.usePlatformKey)
      throw crudErrors.badRequest('不能同时设置租户密钥和使用平台密钥');
    if (!this.config.ai.masterKey)
      throw crudErrors.badRequest('请先配置AI_MASTER_KEY');
    return this.ledger.transaction(async (manager) => {
      await this.quota.aiTokenLimit(this.context.current().tenantId, manager);
      const row = await this.current(manager, true);
      if ((row?.version ?? 0) !== (body.version ?? 0))
        throw crudErrors.versionConflict();
      const keyCipher = body.usePlatformKey
        ? null
        : body.apiKey
          ? this.crypto.encrypt(body.apiKey, 'api-key')
          : (row?.keyCipher ?? null);
      if (body.enabled && !keyCipher && !this.config.ai.apiKey)
        throw crudErrors.badRequest('启用前必须配置平台或租户密钥');
      const values = {
        code: 'default',
        enabled: body.enabled,
        model: body.model,
        maxOutputTokens: Math.min(
          body.maxOutputTokens,
          this.config.ai.maxOutputTokens,
        ),
        keyCipher,
      };
      const id =
        row?.id ?? (await this.repos.for(AiSetting).insert(values, manager));
      if (row) await this.repos.for(AiSetting).update([id], values, manager);
      return { id };
    });
  }
}

@Injectable()
export class AiTemplateService extends BaseService<AiTemplate> {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
    private readonly ledger: IdempotencyLedger,
    private readonly quota: TenantQuotaService,
  ) {
    super();
  }
  private latest(code: string, manager?: EntityManager) {
    return this.repos
      .for(AiTemplate)
      .query('t', manager)
      .andWhere('t.code = :code', { code })
      .orderBy('t.revision', 'DESC')
      .getOne();
  }
  async resolve(code: string, manager?: EntityManager) {
    const own = await this.latest(code, manager);
    const row =
      own ??
      (await this.context.run({ tenantId: '0' }, () =>
        this.latest(code, manager),
      ));
    if (!row) throw crudErrors.badRequest('提示词模板尚未初始化');
    return {
      code: row.code,
      content: row.content,
      revision: row.revision,
      tenantRevision: own?.revision ?? 0,
    };
  }
  async available() {
    return {
      list: await Promise.all(
        ['generate', 'rewrite', 'translate'].map((code) => this.resolve(code)),
      ),
    };
  }
  async saveTemplate(body: AiTemplateSaveBody) {
    validateTemplate(body.content);
    return this.ledger.transaction(async (manager) => {
      await this.quota.aiTokenLimit(this.context.current().tenantId, manager);
      const old = await this.latest(body.code, manager);
      if ((old?.revision ?? 0) !== body.revision)
        throw crudErrors.versionConflict();
      return {
        id: await this.repos.for(AiTemplate).insert(
          {
            code: body.code,
            content: body.content,
            revision: body.revision + 1,
          },
          manager,
        ),
      };
    });
  }
}
