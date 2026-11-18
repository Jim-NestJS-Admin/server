import { Injectable } from '@nestjs/common';
import Provider, {
  errors,
  type Configuration,
  type AccessToken,
  type ClientCredentials,
  type JWK,
} from 'oidc-provider';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { OAuthMetadataFetcher } from './oauth-metadata-fetcher.js';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import { RedisService } from '../../../core/redis/redis.service.js';
import {
  RequestContext,
  type Principal,
} from '../../../core/tenant/request-context.js';
import { TenantSource } from '../../../core/tenant/tenant-source.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { PermissionService } from '../../../core/permission/permission.service.js';
import { PasswordHasher } from '../../../core/auth/password.js';
import { SessionService } from '../../../core/auth/session.service.js';
import { IdempotencyLedger } from '../../../core/security/idempotency.ledger.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { OAuthGrant, OAuthEvent } from '../entity/oauth.entity.js';
import { OAuthClientService } from './oauth-client.service.js';
import { OAuthScopesService } from './oauth-scopes.service.js';
import { OAuthAdapterService } from './oauth-adapter.service.js';
import { SystemOAuthService } from '../../system/service/system-oauth.service.js';
import type { OAuthConsentBody } from '../dto/oauth.dto.js';
export interface OAuthDelegation {
  tenantId: string;
  userId: string;
  orgId: string;
  clientId: string;
  grantId: string;
  audience: string;
  scopes: string[];
  kind: 'human' | 'service';
  expires: number;
}
@Injectable()
export class OAuthRuntimeService {
  private instance?: Provider;
  constructor(
    private readonly config: AppConfigService,
    private readonly clients: OAuthClientService,
    private readonly scopes: OAuthScopesService,
    private readonly adapter: OAuthAdapterService,
    private readonly context: RequestContext,
    private readonly repos: TenantRepositoryFactory,
    private readonly tenants: TenantSource,
    private readonly permissions: PermissionService,
    private readonly sessions: SessionService,
    private readonly system: SystemOAuthService,
    private readonly ledger: IdempotencyLedger,
    private readonly redis: RedisService,
    private readonly metadata: OAuthMetadataFetcher,
  ) {}
  provider() {
    if (!this.config.oauth.enabled || this.config.openApiExport)
      throw crudErrors.notFound();
    if (this.instance) return this.instance;
    const c = this.config.oauth,
      scopes = this.scopes.list().list.map((item) => item.code);
    const configuration: Configuration = {
      discovery: {
        authorization_endpoint: `${c.issuer}/authorize`,
        token_endpoint: `${c.issuer}/token`,
        jwks_uri: `${c.issuer}/jwks`,
        userinfo_endpoint: `${c.issuer}/userinfo`,
        revocation_endpoint: `${c.issuer}/revoke`,
        ...(c.dcr ? { registration_endpoint: `${c.issuer}/register` } : {}),
      },
      adapter: (name) => this.adapter.adapter(name),
      jwks: JSON.parse(c.jwks) as { keys: JWK[] },
      cookies: {
        keys: c.cookieKeys,
        short: {
          httpOnly: true,
          sameSite: 'lax',
          secure: this.config.isProduction,
        },
        long: {
          httpOnly: true,
          sameSite: 'lax',
          secure: this.config.isProduction,
        },
      },
      responseTypes: ['code'],
      clientAuthMethods: ['none', 'client_secret_basic', 'private_key_jwt'],
      clientBasedCORS: (_ctx, origin, client) =>
        client.redirectUris?.some((uri) => new URL(uri).origin === origin) ??
        false,
      scopes: ['openid', 'offline_access', ...scopes],
      claims: { openid: ['sub'] },
      pkce: { required: () => true },
      routes: {
        authorization: '/authorize',
        token: '/token',
        revocation: '/revoke',
        jwks: '/jwks',
        userinfo: '/userinfo',
        registration: '/register',
      },
      features: {
        clientIdMetadataDocument: {
          enabled: c.cimd,
          ack: 'draft-03',
          allowFetch: async (_ctx, id) => !!this.clients.tenantFor(id),
          allowClient: async (_ctx, client) =>
            this.clients.acceptCimd(client.metadata()),
        },
        devInteractions: { enabled: false },
        clientCredentials: { enabled: true },
        registration: {
          enabled: c.dcr,
          idFactory: () => `${c.dcrTenantId}.${randomUUID()}`,
          issueRegistrationAccessToken: false,
        },
        registrationManagement: { enabled: false },
        resourceIndicators: {
          enabled: true,
          defaultResource: () => `${c.issuer.replace(/\/oauth$/, '')}/mcp`,
          useGrantedResource: () => true,
          getResourceServerInfo: async (_ctx, resource, client) => {
            const row = await this.clients.find(client.clientId);
            if (
              !row?.enabled ||
              ![
                `${c.issuer.replace(/\/oauth$/, '')}/mcp`,
                `${c.issuer.replace(/\/oauth$/, '')}/open`,
              ].includes(resource)
            )
              throw new errors.InvalidTarget();
            return {
              scope: row.scopes.join(' '),
              audience: resource,
              accessTokenFormat: 'jwt',
              accessTokenTTL: row.serviceUserId ? 900 : 3600,
              jwt: { sign: { alg: 'RS256' } },
            };
          },
        },
      },
      interactions: {
        url: (_ctx, interaction) =>
          `${c.issuer.replace(/\/oauth$/, '')}/admin/oauth/interaction?redirect=${interaction.uid}`,
      },
      issueRefreshToken: (_ctx, client, code) =>
        !!client.grantTypeAllowed('refresh_token') &&
        !!code.scopes.has('offline_access'),
      rotateRefreshToken: true,
      ttl: {
        AccessToken: 3600,
        AuthorizationCode: 60,
        RefreshToken: 86400 * 7,
        Session: 3600,
        Interaction: 600,
        Grant: 86400 * 7,
        ClientCredentials: 900,
      },
      findAccount: async (_ctx, id, token) => {
        const principal = this.subject(id);
        if (!principal) return undefined;
        return this.context.run(principal, async () => {
          if (!(await this.system.identity(principal.userId!)))
            return undefined;
          if (token?.grantId) {
            const grant = await this.repos
              .for(OAuthGrant)
              .query('g')
              .andWhere('g.grantId=:id', { id: token.grantId })
              .getOne();
            if (
              !grant ||
              grant.ownerId !== principal.userId ||
              grant.orgId !== principal.orgId
            )
              return undefined;
            await this.active(grant);
          }
          return { accountId: id, claims: async () => ({ sub: id }) };
        });
      },
      extraTokenClaims: async (ctx, token) =>
        this.claims(token, ctx.oidc.client?.clientId ?? token.clientId ?? ''),
      fetch: (input, init) => this.metadata.fetch(input, init),
      renderError: async (ctx, out, error) => {
        ctx.status = 'statusCode' in error ? Number(error.statusCode) : 400;
        ctx.type = 'application/json';
        ctx.body = {
          error: out.error,
          error_description: '授权请求无效或已失效',
        };
      },
    };
    const provider = new Provider(c.issuer, configuration);
    provider.proxy = this.config.security.trustProxy > 0;
    // 维护者支持的公开Client原型扩展点：仅启用Basic哈希比对，不启用依赖原始secret的对称签名。
    provider.Client.prototype.compareClientSecret = function (actual) {
      return PasswordHasher.verify(actual, this.clientSecret);
    };
    provider.on('server_error', () => undefined);
    provider.on('grant.error', (ctx) => {
      const clientId = ctx.oidc.client?.clientId,
        tenantId = clientId ? this.clients.tenantFor(clientId) : undefined;
      if (clientId && tenantId)
        void this.context
          .run({ tenantId }, () =>
            this.repos
              .for(OAuthEvent)
              .insert({ action: 'token.rejected', clientId, grantId: null }),
          )
          .catch(() => undefined);
    });
    this.instance = provider;
    return provider;
  }
  private subject(id: string): Principal | null {
    const match = /^([1-9]\d{0,19}):([1-9]\d{0,19}):([1-9]\d{0,19})$/.exec(id);
    return match
      ? { tenantId: match[1]!, userId: match[2]!, orgId: match[3]! }
      : null;
  }
  private async active(grant: OAuthGrant) {
    const tenantId = this.context.current().tenantId,
      client = await this.clients.find(grant.clientId);
    if (
      !grant.active ||
      !(await this.redis.call((r) =>
        r.exists(this.adapter.key('live', grant.grantId)),
      )) ||
      !client?.enabled ||
      client.version !== grant.clientVersion ||
      !(await this.tenants.byId(tenantId))?.enabled ||
      (await this.sessions.userEpoch(tenantId, grant.ownerId)) !==
        grant.userEpoch ||
      !(await this.system.identity(grant.ownerId))
    )
      throw new errors.InvalidGrant('授权已失效');
    await this.context.run(
      { tenantId, userId: grant.ownerId, orgId: grant.orgId },
      () => this.permissions.permissions(),
    );
    return client;
  }
  private async claims(
    token: AccessToken | ClientCredentials,
    clientId: string,
  ) {
    const client = await this.clients.find(clientId),
      tenantId = this.clients.tenantFor(clientId);
    if (!client?.enabled || !tenantId) throw new errors.InvalidClient();
    return this.context.run({ tenantId }, async () => {
      let grant: OAuthGrant | null = null;
      if (token.kind === 'ClientCredentials') {
        if (!client.serviceUserId || !client.serviceOrgId)
          throw new errors.UnauthorizedClient();
        await this.system.assertService(
          client.serviceUserId,
          client.serviceOrgId,
        );
        const id = await this.context.run(
          {
            tenantId,
            userId: client.serviceUserId,
            orgId: client.serviceOrgId,
          },
          () =>
            this.repos.for(OAuthGrant).insert({
              grantId: randomUUID(),
              ownerId: client.serviceUserId!,
              clientId,
              scopes: (token.scope ?? '').split(' ').filter(Boolean),
              audience: String(token.aud ?? ''),
              active: true,
              clientVersion: client.version,
              userEpoch: 0,
              kind: 'service',
            }),
        );
        grant = await this.repos
          .for(OAuthGrant)
          .query('g')
          .andWhere('g.id=:id', { id })
          .getOneOrFail();
        await this.repos.for(OAuthGrant).update([id], {
          userEpoch: await this.sessions.userEpoch(
            tenantId,
            client.serviceUserId,
          ),
        });
        grant.userEpoch = await this.sessions.userEpoch(
          tenantId,
          client.serviceUserId,
        );
        await this.redis.call((r) =>
          r.set(this.adapter.key('live', grant!.grantId), '1', 'EX', 900),
        );
      } else {
        grant = await this.repos
          .for(OAuthGrant)
          .query('g')
          .andWhere('g.grantId=:id', { id: token.grantId })
          .getOne();
      }
      if (!grant) throw new errors.InvalidGrant();
      await this.active(grant);
      const requested = (token.scope ?? '')
        .split(' ')
        .filter((scope) => !['openid', 'offline_access'].includes(scope));
      if (
        requested.some(
          (scope) =>
            !grant!.scopes.includes(scope) || !client.scopes.includes(scope),
        )
      )
        throw new errors.InvalidScope('scope超出授权范围', requested.join(' '));
      await this.repos
        .for(OAuthEvent)
        .insert({ action: 'token.issued', clientId, grantId: grant.grantId });
      return {
        tenant_id: tenantId,
        user_id: grant.ownerId,
        org_id: grant.orgId,
        grant_id: grant.grantId,
        client_id: clientId,
      };
    });
  }
  async details(uid: string, req: Request, res: Response) {
    const details = await this.provider().interactionDetails(req, res);
    if (details.uid !== uid) throw crudErrors.notFound();
    const clientId = String(details.params.client_id),
      client = await this.clients.find(clientId),
      principal = this.context.current();
    if (
      !client?.enabled ||
      this.clients.tenantFor(clientId) !== principal.tenantId
    )
      throw crudErrors.notFound();
    if (!principal.orgId)
      throw crudErrors.badRequest('请先在后台选择当前组织，再进行授权');
    const requested = (
      typeof details.params.scope === 'string' ? details.params.scope : ''
    )
      .split(' ')
      .filter((scope) => !['openid', 'offline_access'].includes(scope));
    const codes = new Set((await this.permissions.permissions()).codes),
      available = this.scopes
        .list()
        .list.filter((item) => item.permissions.some((code) => codes.has(code)))
        .map((item) => item.code);
    const tenant = await this.tenants.byId(principal.tenantId);
    return {
      uid,
      clientName: client.name,
      tenantName: tenant?.name ?? '',
      orgId: principal.orgId,
      scopes: requested.filter(
        (scope) => client.scopes.includes(scope) && available.includes(scope),
      ),
    };
  }
  async consent(body: OAuthConsentBody, req: Request, res: Response) {
    const detail = await this.details(body.uid, req, res);
    if (body.scopes.some((scope) => !detail.scopes.includes(scope)))
      throw crudErrors.badRequest('不能授予未申请或无权使用的scope');
    const lock = this.adapter.key('consent', body.uid),
      claimed = await this.redis.call((r) =>
        r.set(lock, 'used', 'EX', 600, 'NX'),
      );
    if (!claimed) throw crudErrors.versionConflict();
    try {
      return await this.ledger.transaction(async (manager) => {
        const provider = this.provider(),
          interaction = await provider.interactionDetails(req, res),
          clientId = String(interaction.params.client_id),
          client = await this.clients.find(clientId);
        if (!body.approve) {
          await this.repos
            .for(OAuthEvent)
            .insert(
              { action: 'grant.denied', clientId, grantId: null },
              manager,
            );
          return {
            redirectTo: await provider.interactionResult(
              req,
              res,
              { error: 'access_denied' },
              { mergeWithLastSubmission: false },
            ),
          };
        }
        const principal = this.context.current(),
          accountId = `${principal.tenantId}:${principal.userId}:${principal.orgId}`,
          grant = new provider.Grant({ accountId, clientId });
        grant.addOIDCScope(body.scopes);
        grant.rejectOIDCScope(
          detail.scopes.filter((scope) => !body.scopes.includes(scope)),
        );
        grant.addOIDCScope(
          'openid' +
            (String(interaction.params.scope)
              .split(' ')
              .includes('offline_access')
              ? ' offline_access'
              : ''),
        );
        const rawResource = interaction.params.resource;
        if (Array.isArray(rawResource) && rawResource.length > 1)
          throw crudErrors.badRequest('每次授权只允许一个使用对象');
        const audience = String(
          Array.isArray(rawResource)
            ? rawResource[0]
            : (rawResource ??
                `${this.config.oauth.issuer.replace(/\/oauth$/, '')}/mcp`),
        );
        grant.addResourceScope(audience, body.scopes.join(' '));
        grant.rejectResourceScope(
          audience,
          detail.scopes.filter((scope) => !body.scopes.includes(scope)),
        );
        const grantId = await grant.save();
        await this.redis.call((r) =>
          r.set(this.adapter.key('live', grantId), '1', 'EX', 86400 * 7),
        );
        await this.repos.for(OAuthGrant).insert(
          {
            grantId,
            ownerId: principal.userId!,
            clientId,
            scopes: body.scopes,
            audience,
            active: true,
            clientVersion: client!.version,
            userEpoch: await this.sessions.userEpoch(
              principal.tenantId,
              principal.userId!,
            ),
            kind: 'human',
          },
          manager,
        );
        await this.repos
          .for(OAuthEvent)
          .insert({ action: 'grant.approved', clientId, grantId }, manager);
        return {
          redirectTo: await provider.interactionResult(
            req,
            res,
            { login: { accountId, remember: false }, consent: { grantId } },
            { mergeWithLastSubmission: false },
          ),
        };
      });
    } catch (error) {
      await this.redis.call((r) => r.del(lock));
      throw error;
    }
  }
  async runAuthorized<T>(
    token: string,
    audience: string,
    permission: string,
    fn: () => Promise<T>,
  ) {
    return this.withDelegation(token, audience, (identity) =>
      this.authorizeDelegation(identity, permission, async () => {
        if (this.scopes.scopeFor(permission)?.endsWith(':risk'))
          throw crudErrors.badRequest('高风险操作须由MCP服务端确认流程办理');
        return fn();
      }),
    );
  }
  async withDelegation<T>(
    token: string,
    audience: string,
    fn: (identity: OAuthDelegation) => Promise<T>,
  ) {
    if (!this.config.oauth.enabled) throw new errors.InvalidToken();
    const jwks = JSON.parse(this.config.oauth.jwks) as {
      keys: Record<string, unknown>[];
    };
    const publicKeys = jwks.keys.map((key) =>
      Object.fromEntries(
        Object.entries(key).filter(
          ([name]) => !['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].includes(name),
        ),
      ),
    );
    const { payload } = await jwtVerify(
      token,
      createLocalJWKSet({ keys: publicKeys }),
      {
        issuer: this.config.oauth.issuer,
        audience,
        algorithms: ['RS256'],
        typ: 'at+jwt',
      },
    );
    const tenantId = String(payload.tenant_id),
      userId = String(payload.user_id),
      orgId = String(payload.org_id);
    return this.context.runFresh({ tenantId, userId, orgId }, async () => {
      const grant = await this.repos
        .for(OAuthGrant)
        .query('g')
        .andWhere('g.grantId=:id', { id: String(payload.grant_id) })
        .getOne();
      if (
        !grant ||
        grant.ownerId !== userId ||
        grant.orgId !== orgId ||
        grant.audience !== audience ||
        grant.clientId !== payload.client_id
      )
        throw new errors.InvalidToken();
      await this.active(grant);
      return fn({
        tenantId,
        userId,
        orgId,
        clientId: grant.clientId,
        grantId: grant.grantId,
        audience,
        kind: grant.kind,
        scopes:
          typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
        expires: payload.exp ?? 0,
      });
    });
  }
  async authorizeDelegation<T>(
    identity: OAuthDelegation,
    permission: string,
    fn: () => Promise<T>,
  ) {
    return this.context.runFresh(identity, async () => {
      const grant = await this.repos
        .for(OAuthGrant)
        .query('g')
        .andWhere('g.grantId=:id', { id: identity.grantId })
        .getOne();
      if (
        !grant ||
        grant.ownerId !== identity.userId ||
        grant.orgId !== identity.orgId ||
        grant.clientId !== identity.clientId ||
        grant.kind !== identity.kind ||
        grant.audience !== identity.audience ||
        identity.expires <= Date.now() / 1000
      )
        throw new errors.InvalidToken();
      await this.active(grant);
      const scope = this.scopes.scopeFor(permission);
      if (
        !scope ||
        !identity.scopes.includes(scope) ||
        !grant.scopes.includes(scope)
      )
        throw new errors.InsufficientScope('scope不足', scope ?? '');
      await this.permissions.authorize(permission);
      return fn();
    });
  }
  mount(app: INestApplication) {
    const instance = app.getHttpAdapter().getInstance() as {
      use: (
        path: string,
        fn: (req: Request, res: Response, next: NextFunction) => void,
      ) => void;
      get: (
        path: string,
        fn: (req: Request, res: Response, next: NextFunction) => void,
      ) => void;
    };
    instance.get('/admin/oauth/interaction', (req, res, next) => {
      const uid = req.query.redirect;
      if (typeof uid !== 'string' || !/^[-\w]{10,150}$/.test(uid)) {
        next();
        return;
      }
      res.redirect(
        `${this.config.auth.adminOrigins[0]}/?oauth_uid=${encodeURIComponent(uid)}`,
      );
    });
    instance.use('/oauth', (req, res) => {
      void (async () => {
        if (!this.config.oauth.enabled) {
          res.status(404).end();
          return;
        }
        const ip = createHash('sha256')
            .update(req.ip ?? 'unknown')
            .digest('hex'),
          key = this.adapter.key(
            'rate',
            req.path === '/register' ? 'register' : 'protocol',
            ip,
          );
        const count = await this.redis.call((r) =>
          r.eval(
            "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60)end;return n",
            1,
            key,
          ),
        );
        if (Number(count) > (req.path === '/register' ? 10 : 60)) {
          res.status(429).json({ error: 'temporarily_unavailable' });
          return;
        }
        await this.provider().callback()(req, res);
      })().catch(() => {
        if (!res.headersSent)
          res.status(503).json({ error: 'temporarily_unavailable' });
      });
    });
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ])
      instance.get(path, (req, res) => {
        try {
          req.url = '/.well-known/openid-configuration';
          void this.provider().callback()(req, res);
        } catch {
          res.status(404).end();
        }
      });
  }
}
