import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { importJWK } from 'jose';
import type { AdapterPayload } from 'oidc-provider';
import { BaseService } from '../../../core/crud/base.service.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { IdempotencyLedger } from '../../../core/security/idempotency.ledger.js';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import { PasswordHasher } from '../../../core/auth/password.js';
import { PermissionService } from '../../../core/permission/permission.service.js';
import { OAuthClient, OAuthEvent } from '../entity/oauth.entity.js';
import { OAuthScopesService } from './oauth-scopes.service.js';
import type {
  OAuthClientSaveBody,
  OAuthIntegrationSaveBody,
} from '../dto/oauth.dto.js';
import { SystemOAuthService } from '../../system/service/system-oauth.service.js';
import { TenantQuotaService } from '../../tenant/service/tenant-quota.service.js';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../core/exceptions/error-code.js';
export const clientTenant = (id: string) =>
  /^([1-9]\d{0,19})\.[A-Za-z0-9_-]{10,100}$/.exec(id)?.[1];
@Injectable()
export class OAuthClientService extends BaseService<OAuthClient> {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
    private readonly ledger: IdempotencyLedger,
    private readonly config: AppConfigService,
    private readonly scopes: OAuthScopesService,
    private readonly permissions: PermissionService,
    private readonly system: SystemOAuthService,
    private readonly quota: TenantQuotaService,
  ) {
    super();
  }
  async find(clientId: string) {
    const tenantId = this.tenantFor(clientId);
    if (!tenantId) return null;
    return this.context.run({ tenantId }, () =>
      this.repos
        .for(OAuthClient)
        .query('c')
        .addSelect('c.secretHash')
        .andWhere('c.clientId=:id', { id: clientId })
        .getOne(),
    );
  }
  async metadata(clientId: string): Promise<AdapterPayload | undefined> {
    if (clientId.startsWith('https://')) return undefined;
    const row = await this.find(clientId);
    if (!row?.enabled) return undefined;
    return {
      client_id: row.clientId,
      client_name: row.name,
      redirect_uris: row.redirectUris,
      response_types: row.redirectUris.length ? ['code'] : [],
      grant_types:
        row.serviceUserId && !row.redirectUris.length
          ? ['client_credentials']
          : [
              'authorization_code',
              'refresh_token',
              ...(row.serviceUserId ? ['client_credentials'] : []),
            ],
      scope: [
        ...(row.redirectUris.length ? ['openid', 'offline_access'] : []),
        ...row.scopes,
      ].join(' '),
      token_endpoint_auth_method: row.authMethod,
      ...(row.secretHash ? { client_secret: row.secretHash } : {}),
      ...(row.jwks ? { jwks: row.jwks } : {}),
      application_type: 'web',
    } as AdapterPayload;
  }
  tenantFor(id: string) {
    const local = clientTenant(id);
    if (local) return local;
    if (!this.config.oauth.cimd) return undefined;
    try {
      const url = new URL(id);
      if (
        id.length <= 200 &&
        url.protocol === 'https:' &&
        !url.hash &&
        !url.username &&
        !url.password &&
        this.config.oauth.cimdHosts.includes(url.hostname.toLowerCase())
      )
        return this.config.oauth.dcrTenantId;
    } catch {
      /* 非元数据文档ID */
    }
    return undefined;
  }
  async acceptCimd(payload: AdapterPayload) {
    const id = payload.client_id;
    if (!id || !this.tenantFor(id) || clientTenant(id)) return false;
    if (
      payload.token_endpoint_auth_method !== 'none' ||
      payload.grant_types?.some(
        (type) => !['authorization_code', 'refresh_token'].includes(type),
      )
    )
      return false;
    const old = await this.find(id);
    if (old && !old.enabled) return false;
    const redirects = [...(payload.redirect_uris ?? [])];
    if (!redirects.length || redirects.length > 10) return false;
    this.redirects(redirects);
    const scopes = (payload.scope ?? '')
      .split(' ')
      .filter(
        (scope) => scope && !['openid', 'offline_access'].includes(scope),
      );
    if (
      scopes.some(
        (scope) => !this.scopes.list().list.some((item) => item.code === scope),
      )
    )
      return false;
    return this.context.run({ tenantId: this.tenantFor(id)! }, () =>
      this.ledger.transaction(async (manager) => {
        await this.quota.aiTokenLimit(this.context.current().tenantId, manager);
        const current = await this.repos
          .for(OAuthClient)
          .query('c', manager)
          .andWhere('c.clientId=:id', { id })
          .getOne();
        // 文档变更不得覆盖管理员限制。回调或scope变化后须在管理端重新核准。
        if (current)
          return (
            current.enabled &&
            current.authMethod === 'none' &&
            JSON.stringify(current.redirectUris) ===
              JSON.stringify(redirects) &&
            JSON.stringify(current.scopes) === JSON.stringify(scopes)
          );
        const values = {
          name: (payload.client_name ?? '元数据文档应用').slice(0, 100),
          redirectUris: redirects,
          scopes,
          enabled: true,
          authMethod: 'none' as const,
          secretHash: null,
          jwks: null,
          serviceUserId: null,
          serviceOrgId: null,
          dynamic: true,
        };
        if (
          (await this.repos.for(OAuthClient).query('c', manager).getCount()) >=
          100
        )
          return false;
        await this.repos
          .for(OAuthClient)
          .insert({ ...values, clientId: id }, manager);
        await this.scopes.sync(manager);
        await this.repos
          .for(OAuthEvent)
          .insert(
            { action: 'client.cimd-registered', clientId: id, grantId: null },
            manager,
          );
        return true;
      }),
    );
  }
  private redirects(uris: string[]) {
    for (const value of uris) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw crudErrors.badRequest('回调地址无效');
      }
      if (
        value.length > 500 ||
        url.hash ||
        url.username ||
        url.password ||
        !['https:', 'http:'].includes(url.protocol) ||
        (url.protocol === 'http:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
        throw crudErrors.badRequest('回调地址必须HTTPS，回环开发地址除外');
    }
  }
  async saveClient(body: OAuthClientSaveBody) {
    if (this.context.current().tenantId === '0')
      throw crudErrors.badRequest('请在业务租户登记应用');
    this.redirects(body.redirectUris);
    const known = new Set(this.scopes.list().list.map((item) => item.code));
    if (body.scopes.some((scope) => !known.has(scope)))
      throw crudErrors.badRequest('存在未定义scope');
    const allowed = new Set((await this.permissions.permissions()).codes);
    if (
      body.scopes.some(
        (scope) =>
          !this.scopes
            .list()
            .list.find((item) => item.code === scope)
            ?.permissions.some((code) => allowed.has(code)),
      )
    )
      throw crudErrors.badRequest('不能开放本人无权使用的scope');
    if (body.authMethod === 'private_key_jwt') {
      const keys = body.jwks?.keys as Record<string, unknown>[] | undefined;
      if (
        !Array.isArray(keys) ||
        !keys.length ||
        keys.length > 5 ||
        keys.some(
          (key) =>
            !key.kid ||
            ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some(
              (field) => key[field] !== undefined,
            ) ||
            !['RSA', 'EC'].includes(String(key.kty)),
        )
      )
        throw crudErrors.badRequest('客户端JWKS仅允许带kid的非对称公钥');
      for (const key of keys) await importJWK(key);
    }
    return this.ledger.transaction(async (manager) => {
      await this.quota.aiTokenLimit(this.context.current().tenantId, manager);
      await this.scopes.sync(manager);
      const old = body.id
        ? await this.select(manager, 'info')
            .addSelect('e.secretHash')
            .andWhere('e.id=:id', { id: body.id })
            .setLock('pessimistic_write')
            .getOne()
        : null;
      if (body.id && !old) throw crudErrors.notFound();
      if (old?.serviceUserId && !old.redirectUris.length)
        throw crudErrors.badRequest('系统对接应用请从系统对接配置入口修改');
      if (old && old.version !== body.version)
        throw crudErrors.versionConflict();
      if (
        body.authMethod === 'client_secret_basic' &&
        !body.secret &&
        !old?.secretHash
      )
        throw crudErrors.badRequest('首次配置需32至64位随机客户端密钥');
      if (body.serviceUserId) {
        if (body.authMethod === 'none' || !body.serviceOrgId)
          throw crudErrors.badRequest('客户端凭证需机密客户端及固定服务组织');
        await this.system.assertService(
          body.serviceUserId,
          body.serviceOrgId,
          manager,
        );
      }
      const values = {
        name: body.name,
        enabled: body.enabled,
        authMethod: body.authMethod,
        redirectUris: body.redirectUris,
        scopes: body.scopes,
        secretHash:
          body.authMethod === 'client_secret_basic'
            ? body.secret
              ? await PasswordHasher.hash(body.secret)
              : (old?.secretHash ?? null)
            : null,
        jwks: body.authMethod === 'private_key_jwt' ? body.jwks! : null,
        serviceUserId: body.serviceUserId ?? null,
        serviceOrgId: body.serviceUserId ? (body.serviceOrgId ?? null) : null,
      };
      const clientId =
        old?.clientId ?? `${this.context.current().tenantId}.${randomUUID()}`;
      const id =
        old?.id ??
        (await this.repos
          .for(OAuthClient)
          .insert({ ...values, clientId, dynamic: false }, manager));
      if (old) await this.repos.for(OAuthClient).update([id], values, manager);
      await this.repos.for(OAuthEvent).insert(
        {
          action: old ? 'client.updated' : 'client.created',
          clientId,
          grantId: null,
        },
        manager,
      );
      return { id };
    });
  }
  async integrationInfo(id: string) {
    if (!(await this.permissions.isSuperAdmin()))
      throw new BusinessException(
        ErrorCode.Forbidden,
        '只有租户管理员可以配置系统对接权限',
        403,
      );
    const row = await this.select(this.crud.dataSource.manager, 'info')
      .andWhere('e.id=:id', { id })
      .getOne();
    if (!row?.serviceUserId || !row.serviceOrgId || row.redirectUris.length)
      throw crudErrors.notFound();
    return {
      id: row.id,
      clientId: row.clientId,
      version: row.version,
      name: row.name,
      enabled: row.enabled,
      orgId: row.serviceOrgId,
      roleIds: await this.system.integrationRoles(row.serviceUserId),
      scopes: row.scopes,
    };
  }
  async saveIntegration(body: OAuthIntegrationSaveBody) {
    const tenantId = this.context.current().tenantId;
    if (tenantId === '0')
      throw crudErrors.badRequest('请在业务租户创建接入应用');
    const result = await this.ledger.transaction(async (manager) => {
      await this.quota.aiTokenLimit(tenantId, manager);
      const old = body.id
        ? await this.select(manager, 'info')
            .addSelect('e.secretHash')
            .andWhere('e.id=:id', { id: body.id })
            .setLock('pessimistic_write')
            .getOne()
        : null;
      if (body.id && (!old?.serviceUserId || old.redirectUris.length))
        throw crudErrors.notFound();
      if (old && old.version !== body.version)
        throw crudErrors.versionConflict();
      if (!body.secret && !old?.secretHash)
        throw crudErrors.badRequest('请先生成并保存客户端密钥');
      if (
        old &&
        (await this.repos
          .for(OAuthClient)
          .query('c', manager)
          .andWhere('c.serviceUserId=:userId', { userId: old.serviceUserId })
          .getCount()) !== 1
      )
        throw crudErrors.badRequest(
          '服务身份已被其他应用引用，请先分离后再修改权限',
        );
      const provision = await this.system.provisionIntegration(
        body.name,
        body.orgId,
        body.roleIds,
        manager,
        old?.serviceUserId ?? undefined,
      );
      const scopes = [
        ...new Set(
          provision.permissions
            .map((code) => this.scopes.scopeFor(code))
            .filter((scope): scope is string => !!scope),
        ),
      ].sort();
      if (!scopes.length)
        throw crudErrors.badRequest('所选角色没有可对外授权的业务权限');
      const values = {
        name: body.name,
        enabled: body.enabled,
        authMethod: 'client_secret_basic' as const,
        redirectUris: [],
        scopes,
        secretHash: body.secret
          ? await PasswordHasher.hash(body.secret)
          : old!.secretHash,
        jwks: null,
        serviceUserId: provision.userId,
        serviceOrgId: body.orgId,
      };
      const clientId = old?.clientId ?? `${tenantId}.${randomUUID()}`;
      const id =
        old?.id ??
        (await this.repos
          .for(OAuthClient)
          .insert({ ...values, clientId, dynamic: false }, manager));
      if (old) await this.repos.for(OAuthClient).update([id], values, manager);
      await this.scopes.sync(manager);
      await this.repos.for(OAuthEvent).insert(
        {
          action: old ? 'integration.updated' : 'integration.created',
          clientId,
          grantId: null,
        },
        manager,
      );
      return { id, clientId };
    });
    await this.permissions.bumpVersion(tenantId);
    return result;
  }
  async registerDynamic(id: string, payload: AdapterPayload) {
    const tenantId = this.config.oauth.dcrTenantId;
    if (!this.config.oauth.dcr || !tenantId || clientTenant(id) !== tenantId)
      throw crudErrors.badRequest('自动注册未启用');
    if (
      payload.token_endpoint_auth_method !== 'none' ||
      payload.grant_types?.some(
        (type) => !['authorization_code', 'refresh_token'].includes(type),
      ) ||
      payload.jwks_uri ||
      payload.sector_identifier_uri ||
      payload.request_uris
    )
      throw crudErrors.badRequest('自动注册仅允许PKCE公共客户端');
    const redirects = payload.redirect_uris ?? [];
    if (!redirects.length || redirects.length > 10)
      throw crudErrors.badRequest('回调地址数量无效');
    this.redirects([...redirects]);
    const scopes = (payload.scope ?? 'openid')
      .split(' ')
      .filter((scope) => !['openid', 'offline_access'].includes(scope));
    if (
      scopes.some(
        (scope) => !this.scopes.list().list.some((item) => item.code === scope),
      )
    )
      throw crudErrors.badRequest('scope无效');
    await this.context.run({ tenantId }, () =>
      this.ledger.transaction(async (manager) => {
        await this.quota.aiTokenLimit(tenantId, manager);
        if (
          (await this.repos.for(OAuthClient).query('c', manager).getCount()) >=
          100
        )
          throw crudErrors.badRequest('自动注册应用数量已达上限');
        await this.repos.for(OAuthClient).insert(
          {
            clientId: id,
            name: payload.client_name ?? '自动注册应用',
            enabled: true,
            authMethod: 'none',
            redirectUris: [...redirects],
            scopes,
            secretHash: null,
            jwks: null,
            serviceUserId: null,
            serviceOrgId: null,
            dynamic: true,
          },
          manager,
        );
        await this.scopes.sync(manager);
        await this.repos
          .for(OAuthEvent)
          .insert(
            { action: 'client.registered', clientId: id, grantId: null },
            manager,
          );
      }),
    );
  }
}
