import { CodeRuleService } from '../src/modules/code-rule/service/code-rule.service.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { OAuthRuntimeService } from '../src/modules/oauth/service/oauth-runtime.service.js';
import { McpService } from '../src/modules/mcp/service/mcp.service.js';
import {
  McpOperation,
  McpUsage,
} from '../src/modules/mcp/entity/mcp.entity.js';
import { OAuthClient } from '../src/modules/oauth/entity/oauth.entity.js';
import { NotifyMessage } from '../src/modules/notify/entity/notify.entity.js';
import { OAuthMetadataFetcher } from '../src/modules/oauth/service/oauth-metadata-fetcher.js';
import { ConfigService } from '@nestjs/config';
import { AuthUserStore } from '../src/core/auth/auth-user.store.js';
import { SessionService } from '../src/core/auth/session.service.js';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { RequestContext } from '../src/core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../src/core/tenant/tenant-repository.js';
import { SystemTenantService } from '../src/modules/system/service/system-tenant.service.js';
import {
  SystemUser,
  SystemRole,
  SystemUserRole,
  SystemUserSupervisor,
  SystemOrg,
  SystemMenu,
} from '../src/modules/system/entity/system.entity.js';
import { PermissionRegistry } from '../src/core/permission/permission-registry.js';
import { PermissionService } from '../src/core/permission/permission.service.js';
import { SystemRoleField } from '../src/modules/system/entity/system-field.entity.js';
import {
  TenantPackage,
  SystemTenant,
  TenantQuotas,
} from '../src/modules/tenant/entity/tenant.entity.js';
import { DictionaryTags1794614400000 } from '../src/database/migrations/1794614400000-DictionaryTags.js';
import { CommonCodeRuleStatus1794618000000 } from '../src/database/migrations/1794618000000-CommonCodeRuleStatus.js';
import { NotifyWorkerService } from '../src/modules/notify/service/notify-worker.service.js';
import { rawRedis } from './support/test-redis.js';
import { assertTestDatabase } from './support/test-database.js';
import {
  AiProvider,
  AiProviderFailure,
} from '../src/modules/ai/service/ai-provider.js';
import { AiService } from '../src/modules/ai/service/ai.service.js';
import { AiQueueService } from '../src/modules/ai/service/ai-queue.service.js';
import { AiTask } from '../src/modules/ai/entity/ai.entity.js';
import { AiFoundation1794722400000 } from '../src/database/migrations/1794722400000-AiFoundation.js';
await vi.hoisted(async () => {
  process.env.AI_MASTER_KEY = 'ab'.repeat(32);
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.OAUTH_ENABLED = 'true';
  process.env.MCP_ENABLED = 'true';
  process.env.OAUTH_ISSUER = 'http://127.0.0.1:3012/oauth';
  process.env.OAUTH_MASTER_KEY = 'cd'.repeat(32);
  process.env.OAUTH_COOKIE_KEYS = 'fixture-cookie-key-at-least-32-characters';
  process.env.OAUTH_DCR_ENABLED = 'true';
  process.env.OAUTH_DCR_TENANT_ID = '1';
  process.env.OAUTH_CIMD_ENABLED = 'true';
  process.env.OAUTH_CIMD_HOSTS = 'metadata.example';
  process.env.OAUTH_JWKS = JSON.stringify({
    keys: [
      {
        ...privateKey.export({ format: 'jwk' }),
        kid: 'fixture-key',
        alg: 'RS256',
        use: 'sig',
      },
    ],
  });
});
const provider = {
  async stream(
    _input: unknown,
    onText: (text: string) => Promise<void>,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const result = await provider.generate();
    await onText(result.text);
    return result;
  },
  count: vi.fn(async () => 200),
  generate: vi.fn(async () => ({
    text: '测试草稿，待人工校对',
    inputTokens: 200,
    outputTokens: 30,
  })),
};

/** 仅独立_test库；真实出题、认证、会话和权限，不替换正式身份来源。 */
describe('T48–T50 AI与OAuth真实身份定向验证', () => {
  let app: INestApplication;
  let db: DataSource;
  let context: RequestContext;
  let repos: TenantRepositoryFactory;
  const redis = rawRedis();
  const suffix = randomUUID().slice(0, 8);
  const codes = [`smokea-${suffix}`, `smokeb-${suffix}`];
  const tenants: string[] = [];
  const users: string[] = [];
  const orgs: string[] = [];
  const tokens: string[] = [];
  const password = 'SmokeFixturePassword8';
  let limitedToken = '';
  let packageId = '';
  let peerId = '',
    peerToken = '';
  const http = () => request(app.getHttpServer());
  const post = (path: string, token: string, body: object) =>
    http()
      .post('/admin/' + path)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  let oauthClientId = '',
    oauthClientRow = '',
    oauthAccess = '',
    oauthRefresh = '';
  const audience = 'http://127.0.0.1:3012/mcp';
  async function authorizeOAuth(
    scopes = ['ai:read'],
    sessionToken = tokens[0],
  ) {
    const agent = request.agent(app.getHttpServer()),
      verifier = 'fixture-pkce-verifier-'.repeat(3),
      challenge = createHash('sha256').update(verifier).digest('base64url');
    const start = await agent
      .get('/oauth/authorize')
      .query({
        client_id: oauthClientId,
        redirect_uri: 'https://client.example/callback',
        response_type: 'code',
        scope: ['openid', 'offline_access', ...scopes].join(' '),
        resource: audience,
        state: 'fixture-state',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'consent',
      })
      .expect(303);
    const uid = new URL(start.headers.location).searchParams.get('redirect')!;
    expect(uid).toBeTruthy();
    const persisted = await app
      .get(OAuthRuntimeService)
      .provider()
      .Interaction.find(uid);
    expect(persisted?.uid).toBe(uid);
    expect(persisted?.params?.client_id).toBe(oauthClientId);
    await agent
      .get('/admin/oauth/interaction')
      .query({ uid })
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect((response) => {
        if (response.status !== 200)
          throw new Error('授权详情响应：' + JSON.stringify(response.body));
      })
      .expect(200);
    const consent = await agent
      .post('/admin/oauth/interaction/complete')
      .set('Authorization', `Bearer ${sessionToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ uid, approve: true, scopes })
      .expect(200);
    const resume = new URL(consent.body.data.redirectTo);
    const redirected = await agent
      .get(resume.pathname + resume.search)
      .expect(303);
    const callback = new URL(redirected.headers.location);
    if (callback.origin !== 'https://client.example') {
      const next = await app
        .get(OAuthRuntimeService)
        .provider()
        .Interaction.find(callback.searchParams.get('redirect')!);
      throw new Error('再次要求授权：' + JSON.stringify(next?.prompt));
    }
    expect(callback.origin).toBe('https://client.example');
    expect(callback.searchParams.get('state')).toBe('fixture-state');
    const code = callback.searchParams.get('code');
    expect(code).toBeTruthy();
    const result = await http().post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      client_id: oauthClientId,
      redirect_uri: 'https://client.example/callback',
      code,
      code_verifier: verifier,
      resource: audience,
    });
    if (result.status !== 200)
      throw new Error('OAuth换令牌失败：' + JSON.stringify(result.body));
    return { result, code, verifier };
  }
  async function login(index: number, username = 'admin') {
    const challenge = await http()
      .get('/admin/auth/captcha')
      .set('X-Tenant-Code', codes[index])
      .query({ purpose: 'login', account: username })
      .expect(200);
    const captchaId = challenge.body.data.captchaId as string;
    const saved = await redis.get(
      `jna-test:t:${tenants[index]}:auth:captcha:${captchaId}`,
    );
    expect(saved).not.toBeNull();
    const answer = (JSON.parse(saved!) as { answer: string }).answer;
    const response = await http()
      .post('/admin/auth/login')
      .set('X-Tenant-Code', codes[index])
      .send({ username, password, captchaId, captchaCode: answer })
      .expect(200);
    expect(response.body.code).toBe(1000);
    return response.body.data.accessToken as string;
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AiProvider)
      .useValue(provider)
      .overrideProvider(OAuthMetadataFetcher)
      .useValue({
        fetch: async (input: unknown) => {
          if (String(input) !== 'https://metadata.example/client.json')
            throw new Error('非测试元数据地址');
          return new Response(
            JSON.stringify({
              client_id: 'https://metadata.example/client.json',
              client_name: '测试CIMD客户端',
              redirect_uris: ['https://client.example/callback'],
              response_types: ['code'],
              grant_types: ['authorization_code', 'refresh_token'],
              token_endpoint_auth_method: 'none',
              scope: 'openid offline_access ai:read',
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        },
      })
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(DataSource);
    context = app.get(RequestContext);
    repos = app.get(TenantRepositoryFactory);
    assertTestDatabase(db.options.database, process.env.DB_NAME);
    const runner = db.createQueryRunner();
    try {
      await new DictionaryTags1794614400000().up(runner);
      await new CommonCodeRuleStatus1794618000000().up(runner);
      await new AiFoundation1794722400000().up(runner);
    } finally {
      await runner.release();
    }
    const system = app.get(SystemTenantService),
      hash = await system.passwordHash(password);
    await context.run({ tenantId: '0' }, () =>
      db.transaction(async (manager) => {
        const menuIds: string[] = [];
        for (const permission of app.get(PermissionRegistry).all()) {
          if (
            permission.code.startsWith('platform:') ||
            permission.code.startsWith('system:menu:')
          )
            continue;
          menuIds.push(
            await repos.for(SystemMenu).insert(
              {
                type: 'button',
                scope: 'tenant',
                title: permission.code,
                path: '',
                component: null,
                permission: permission.code,
                parentId: null,
                rank: 0,
                hidden: true,
                keepAlive: false,
              },
              manager,
            ),
          );
        }
        packageId = await repos.for(TenantPackage).insert(
          {
            code: `smoke-${suffix}`,
            name: '冒烟独立套餐',
            enabled: true,
            menuIds,
            quotas: new TenantQuotas(),
          },
          manager,
        );
        for (const code of codes)
          tenants.push(
            await repos
              .for(SystemTenant)
              .insert(
                { code, name: code, packageId, domains: [], enabled: true },
                manager,
              ),
          );
      }),
    );
    for (const tenantId of tenants)
      await context.run({ tenantId }, () =>
        db.transaction(async (manager) => {
          const result = await system.initialize(
            manager,
            '冒烟组织',
            'admin',
            hash,
          );
          await repos.for(SystemUserRole).insert(
            {
              userId: result.userId,
              roleId: result.roleId,
              scopeOrgId: result.orgId,
            },
            manager,
          );
          users.push(result.userId);
          orgs.push(result.orgId);
        }),
      );
    await context.run({ tenantId: tenants[0] }, () =>
      db.transaction(async (manager) => {
        const roleId = await repos.for(SystemRole).insert(
          {
            code: 'limited',
            name: '无动作权限',
            enabled: true,
            allPermissions: false,
            permissions: [],
            dataScope: 'self',
            customOrgIds: [],
          },
          manager,
        );
        const userId = await repos.for(SystemUser).insert(
          {
            username: 'limited',
            nickname: '受限测试成员',
            passwordHash: hash,
            enabled: true,
            defaultOrgId: orgs[0],
            avatar: null,
            locale: 'zh-CN',
          },
          manager,
        );
        await repos
          .for(SystemUserRole)
          .insert({ userId, roleId, scopeOrgId: orgs[0] }, manager);
      }),
    );
    tokens.push(await login(0), await login(1));
    limitedToken = await login(0, 'limited');
    await context.run({ tenantId: tenants[0] }, () =>
      db.transaction(async (manager) => {
        const grant = await repos
          .for(SystemUserRole)
          .query('r', manager)
          .andWhere('r.userId=:id', { id: users[0] })
          .getOneOrFail();
        peerId = await repos.for(SystemUser).insert(
          {
            username: 'peer',
            nickname: '同组织测试成员',
            passwordHash: hash,
            enabled: true,
            defaultOrgId: orgs[0],
            avatar: null,
            locale: 'zh-CN',
          },
          manager,
        );
        await repos
          .for(SystemUserRole)
          .insert(
            { userId: peerId, roleId: grant.roleId, scopeOrgId: orgs[0] },
            manager,
          );
      }),
    );
    peerToken = await login(0, 'peer');
    app.get(ConfigService).set('OAUTH_DCR_TENANT_ID', tenants[0]);
  }, 120000);
  afterAll(async () => {
    await redis.quit();
    await app?.close();
  });

  it('迁移后启动健康、真实登录资料正确，无权限和跨租户资源被拒绝', async () => {
    await http().get('/health').expect(200);
    await http().post('/admin/system/org/page').send({}).expect(401);
    const profile = await http()
      .get('/admin/session/profile')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);
    expect(profile.body.data.tenant.id).toBe(tenants[0]);
    await post('system/org/page', limitedToken, {}).expect(403);
    await post('system/org/info', tokens[1], { id: orgs[0] }).expect(404);
    await post('platform/tenant/page', tokens[0], {}).expect(403);
  });

  it('新增列表按统一页面描述开放查询，密文字段不能进入搜索和筛选', async () => {
    const queries: Record<string, Record<string, unknown>> = {
      'oauth/client': {
        clientId: 'unused',
        enabled: false,
        authMethod: 'none',
        serviceOrgId: orgs[0],
      },
      'oauth/grant': { clientId: 'unused', active: false, audience },
      'oauth/event': {
        action: 'unused',
        clientId: 'unused',
        grantId: 'unused',
      },
      'mcp/event': {
        event: 'unused',
        clientId: 'unused',
        resource: 'system.parameter',
        action: 'info',
        operationId: '1',
      },
      'ai/task': { feature: 'generate', status: 'queued', model: 'unused' },
      'ai/template': { code: 'generate', revision: 1 },
      'ai/reconciliation': { taskId: '1', charged: false },
      'notify/message': {
        event: 'task.created',
        instanceId: '1',
        readAt: null,
      },
      'integration/app': {
        platform: 'wecom',
        enabled: false,
        mountOrgId: orgs[0],
      },
      'integration/sync-log': { appId: '1', status: 'pending' },
      'workflow/record': {
        instanceId: '1',
        taskId: '1',
        actorId: '1',
        action: 'approve',
        round: 1,
      },
    };
    for (const [path, eq] of Object.entries(queries)) {
      const response = await http()
        .get(`/admin/${path}/schema`)
        .set('Authorization', `Bearer ${tokens[0]}`)
        .expect(200);
      const schema = response.body.data as {
        actions: { page: { keyWords: string[]; filterable: string[] } };
        query: { field: string }[];
      };
      expect(schema.actions.page.keyWords.length, path).toBeGreaterThan(0);
      expect(schema.query.map((item) => item.field)).toEqual(
        schema.actions.page.filterable,
      );
      expect(
        [
          ...schema.actions.page.keyWords,
          ...schema.actions.page.filterable,
        ].some((field) =>
          /secret|cipher|password|payload|formPatch/i.test(field),
        ),
        path,
      ).toBe(false);
      await post(`${path}/page`, tokens[0], {
        keyword: '不存在的查询回归标记',
        eq,
      }).expect((response) => {
        expect(
          response.status,
          `${path}: ${JSON.stringify(response.body)}`,
        ).toBe(200);
      });
    }
    await post('oauth/client/page', limitedToken, {}).expect(403);
    await post('oauth/grant/page', limitedToken, {}).expect(403);
    await http()
      .get('/admin/oauth/grant/mine')
      .set('Authorization', `Bearer ${limitedToken}`)
      .expect(200);
    await post('oauth/client/page', tokens[0], {
      eq: { secretHash: '不允许查询' },
    }).expect(400);
    await post('oauth/client/page', tokens[0], {
      eq: { enabled: 'false' },
    }).expect(400);
    await post('notify/message/page', tokens[0], {
      eq: { readAt: '2026-01-01T00:00:00.000Z' },
    }).expect(200);
  });

  it('OAuth应用关键词、布尔筛选和组合查询生效，通配符转义且不混入其他租户', async () => {
    const name = `查询_%${suffix}`;
    const secret = randomUUID().replaceAll('-', '');
    const create = (
      token: string,
      enabled: boolean,
      confidential = false,
      clientName = name,
    ) =>
      post('oauth/client/save', token, {
        name: clientName,
        enabled,
        authMethod: confidential ? 'client_secret_basic' : 'none',
        ...(confidential ? { secret } : {}),
        redirectUris: ['https://client.example/callback'],
        scopes: ['ai:read'],
      }).expect(200);
    const own = await create(tokens[0], true);
    await create(tokens[0], false, true);
    await create(tokens[0], true, false, `查询X${suffix}`);
    const other = await create(tokens[1], true);
    const all = await post('oauth/client/page', tokens[0], {
      keyword: name,
    }).expect(200);
    expect(all.body.data.total).toBe(2);
    expect(
      all.body.data.list.map((row: { id: string }) => row.id),
    ).not.toContain(other.body.data.id);
    const detail = await post('oauth/client/info', tokens[0], {
      id: own.body.data.id,
    }).expect(200);
    const selected = await post('oauth/client/page', tokens[0], {
      keyword: name,
      eq: { enabled: true },
      where: {
        op: 'and',
        items: [
          { field: 'authMethod', op: 'eq', value: 'none' },
          { field: 'clientId', op: 'eq', value: detail.body.data.clientId },
        ],
      },
    });
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);
    expect(selected.body.data.total).toBe(1);
    expect(selected.body.data.list[0].id).toBe(own.body.data.id);
    const disabled = await post('oauth/client/page', tokens[0], {
      keyword: name,
      eq: { enabled: false },
    }).expect(200);
    expect(disabled.body.data.total).toBe(1);
    expect(disabled.body.data.list[0].authMethod).toBe('client_secret_basic');
    expect(JSON.stringify(all.body.data)).not.toContain(secret);
    expect(JSON.stringify(all.body.data)).not.toContain('secretHash');
    const miss = await post('oauth/client/page', tokens[0], {
      keyword: `${name}未命中`,
    }).expect(200);
    expect(miss.body.data.total).toBe(0);
  });

  it('初始化编码→分组发布→保存草稿→发起→站内信送达→并行审批办结', async () => {
    const token = tokens[0];
    const defaults = app.get(CodeRuleService);
    await context.run({ tenantId: tenants[0] }, () =>
      defaults.ensureDocumentDefaults(),
    );
    await context.run({ tenantId: tenants[0] }, () =>
      defaults.ensureDocumentDefaults(),
    );
    const form = (
      await post('form/definition/add', token, {
        data: {
          name: '冒烟表单',
          designer: {
            schemaVersion: 1,
            rule: [
              {
                type: 'input',
                field: 'reason',
                title: '原因',
                $required: true,
              },
            ],
          },
        },
      }).expect(200)
    ).body.data;
    expect(form.code).toBe('form_000001');
    await post('form/definition/info', tokens[1], { id: form.id }).expect(404);
    const approval = (id: string, user: string) => ({
      id,
      name: id,
      type: 'approve',
      actor: { type: 'users', ids: [user] },
      mode: 'all',
      empty: 'stop',
      skipRepeated: false,
      rejectTo: 'applicant',
      fieldPermissions: { reason: 'readonly' },
    });
    const definitionData = (secondUser: string) => ({
      name: '冒烟审批',
      category: '人事',
      description: '',
      formDefinitionId: form.id,
      designer: {
        schemaVersion: 1,
        nodes: [
          {
            id: 'parallel',
            name: '并行审批',
            type: 'parallel',
            branches: [
              {
                id: 'branch_a',
                name: '分支A',
                nodes: [approval('approve_a', peerId)],
              },
              {
                id: 'branch_b',
                name: '分支B',
                nodes: [approval('approve_b', secondUser)],
              },
            ],
          },
        ],
      },
    });
    await post('workflow/definition/add', token, {
      data: definitionData(peerId),
    }).expect(400);
    const definition = (
      await post('workflow/definition/add', token, {
        data: definitionData(users[0]!),
      }).expect(200)
    ).body.data;
    expect(definition.code).toBe('wf_000001');
    expect(
      (await post('workflow/definition/available', token, {}).expect(200)).body
        .data.total,
    ).toBe(0);
    await post('workflow/definition/publish', token, {
      id: definition.id,
      version: definition.version,
    }).expect(200);
    expect(
      (await post('workflow/definition/available', token, {}).expect(200)).body
        .data.list,
    ).toMatchObject([
      { id: definition.id, name: '冒烟审批', category: '人事' },
    ]);
    expect(
      (
        await post('workflow/definition/available', tokens[1], {
          id: definition.id,
        }).expect(200)
      ).body.data.total,
    ).toBe(0);
    const payload = {
      definitionId: definition.id,
      values: { reason: '独立测试库最短闭环' },
    };
    const base = { definitionId: definition.id, values: {} };
    await post('workflow/instance/start-application', token, base).expect(400);
    const draft = (
      await post('workflow/instance/draft-save', token, base).expect(200)
    ).body.data;
    expect(
      (await post('workflow/instance/draft-page', token, {}).expect(200)).body
        .data.list,
    ).toMatchObject([{ id: draft.id }]);
    await post('workflow/instance/draft-info', peerToken, {
      id: draft.id,
    }).expect(404);
    await post('workflow/instance/draft-info', tokens[1], {
      id: draft.id,
    }).expect(404);
    expect(
      (
        await post('workflow/instance/draft-info', token, {
          id: draft.id,
        }).expect(200)
      ).body.data.values,
    ).toEqual({});
    expect(
      (await post('workflow/instance/page', token, {}).expect(200)).body.data
        .total,
    ).toBe(0);
    expect(
      (await post('form/submission/page', token, {}).expect(200)).body.data
        .total,
    ).toBe(0);
    expect(
      (await post('notify/message/page', token, {}).expect(200)).body.data
        .total,
    ).toBe(0);
    const draftPayload = {
      ...payload,
      draftId: draft.id,
      version: draft.version,
    };
    const instance = (
      await post(
        'workflow/instance/start-application',
        token,
        draftPayload,
      ).expect(200)
    ).body.data;
    const instanceId = instance.id as string;
    expect(
      (
        await post(
          'workflow/instance/start-application',
          token,
          draftPayload,
        ).expect(200)
      ).body.data.id,
    ).toBe(instanceId);
    expect(
      (await post('workflow/instance/draft-page', token, {}).expect(200)).body
        .data.total,
    ).toBe(0);
    expect(
      (await post('form/submission/page', token, {}).expect(200)).body.data
        .total,
    ).toBe(1);

    const worker = app.get(NotifyWorkerService) as unknown as {
      consume(): Promise<void>;
    };
    await context.run({ tenantId: tenants[0] }, () => worker.consume());
    await context.run({ tenantId: tenants[0] }, () => worker.consume());
    const tasks = [];
    for (const assigneeToken of [peerToken, token]) {
      const inbox = (
        await post('notify/message/page', assigneeToken, {
          eq: { instanceId },
        }).expect(200)
      ).body.data.list;
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ event: 'task.created', instanceId });
      const pending = (
        await post('workflow/task/page', assigneeToken, {
          eq: { instanceId, status: 'pending', kind: 'approve' },
        }).expect(200)
      ).body.data.list;
      const task = pending.find(
        (row: { id: string }) => row.id === inbox[0].taskId,
      );
      expect(task).toBeDefined();
      await post('workflow/instance/document', assigneeToken, {
        id: instanceId,
        taskId: task.id,
      }).expect(200);
      tasks.push(task);
    }
    await post('workflow/instance/document', tokens[1], {
      id: instanceId,
    }).expect(404);
    const first = await post('workflow/task/approve', peerToken, {
      id: tasks[0].id,
      version: tasks[0].version,
    }).expect(200);
    expect(first.body.data.status).toBe('running');
    const approved = await post('workflow/task/approve', token, {
      id: tasks[1].id,
      version: tasks[1].version,
    }).expect(200);
    expect(approved.body.data.status).toBe('approved');
    await post('workflow/task/approve', token, {
      id: tasks[1].id,
      version: tasks[1].version,
    }).expect(409);
    await context.run({ tenantId: tenants[0] }, () => worker.consume());
    const messages = (
      await post('notify/message/page', token, { eq: { instanceId } }).expect(
        200,
      )
    ).body.data.list;
    expect(
      messages.filter(
        (m: { event: string }) => m.event === 'instance.approved',
      ),
    ).toHaveLength(1);
    expect(messages[0]).not.toHaveProperty('values');
    expect(
      (await post('notify/message/page', tokens[1], {}).expect(200)).body.data
        .total,
    ).toBe(0);

    const key = randomUUID();
    const direct = () =>
      post('workflow/instance/start-application', token, payload).set(
        'Idempotency-Key',
        key,
      );
    const directResult = await direct().expect(200);
    expect((await direct().expect(200)).body.data.id).toBe(
      directResult.body.data.id,
    );
    expect(
      (await post('form/submission/page', token, {}).expect(200)).body.data
        .total,
    ).toBe(2);
  }, 60000);

  it('按发起人预览负责人和上级，发起后展示实际待办和审批意见', async () => {
    const token = tokens[0];
    await context.run({ tenantId: tenants[0] }, () =>
      db.transaction(async (manager) => {
        await repos
          .for(SystemOrg)
          .update([orgs[0]!], { leaderId: peerId }, manager);
        await repos
          .for(SystemUserSupervisor)
          .insert({ userId: users[0]!, supervisorId: peerId }, manager);
      }),
    );
    await context.run({ tenantId: tenants[0] }, () =>
      app.get(CodeRuleService).ensureDocumentDefaults(),
    );
    const form = (
      await post('form/definition/add', token, {
        data: {
          name: '审批预览表单',
          designer: {
            schemaVersion: 1,
            rule: [
              {
                type: 'input',
                field: 'reason',
                title: '原因',
                $required: true,
              },
            ],
          },
        },
      }).expect(200)
    ).body.data;
    const definition = (
      await post('workflow/definition/add', token, {
        data: {
          name: '预览负责人和上级',
          category: '人事',
          formDefinitionId: form.id,
          designer: {
            schemaVersion: 1,
            nodes: [
              {
                id: 'lead',
                name: '部门复核',
                actor: { type: 'department_leader', level: 1 },
              },
              {
                id: 'superior',
                name: '上级审批',
                actor: { type: 'supervisor', level: 1 },
              },
            ].map((node) => ({
              ...node,
              type: 'approve',
              mode: 'all',
              empty: 'stop',
              skipRepeated: false,
              rejectTo: 'applicant',
            })),
          },
        },
      }).expect(200)
    ).body.data;
    await post('workflow/definition/publish', token, {
      id: definition.id,
      version: definition.version,
    }).expect(200);
    const preview = (
      await post('workflow/definition/available', token, {
        id: definition.id,
      }).expect(200)
    ).body.data.list[0];
    expect(preview).not.toHaveProperty('designer');
    expect(preview.progress).toMatchObject([
      {
        id: 'lead',
        actorType: 'department_leader',
        members: [{ id: peerId, name: '同组织测试成员' }],
      },
      {
        id: 'superior',
        actorType: 'supervisor',
        members: [{ id: peerId, name: '同组织测试成员' }],
      },
    ]);
    const peerPreview = (
      await post('workflow/definition/available', peerToken, {
        id: definition.id,
      }).expect(200)
    ).body.data.list[0];
    expect(peerPreview.progress[1].members).toEqual([]);
    const instance = (
      await post('workflow/instance/start-application', token, {
        definitionId: definition.id,
        values: { reason: '预览和正式派单一致' },
      }).expect(200)
    ).body.data;
    const document = async () =>
      (
        await post('workflow/instance/document', token, {
          id: instance.id,
        }).expect(200)
      ).body.data;
    expect((await document()).progress).toMatchObject([
      { id: 'lead', status: 'pending', members: [{ id: peerId }] },
      { id: 'superior', status: 'waiting', members: [] },
    ]);
    const pending = (
      await post('workflow/task/page', peerToken, {
        eq: { instanceId: instance.id, status: 'pending' },
      }).expect(200)
    ).body.data.list[0];
    await post('workflow/task/approve', peerToken, {
      id: pending.id,
      version: pending.version,
      comment: '已核对，同意',
    }).expect(200);
    expect((await document()).progress).toMatchObject([
      { id: 'lead', status: 'approved' },
      { id: 'superior', status: 'pending', members: [{ id: peerId }] },
    ]);
    const records = (
      await post('workflow/record/page', token, {
        eq: { instanceId: instance.id },
      }).expect(200)
    ).body.data.list;
    expect(records).toContainEqual(
      expect.objectContaining({ comment: '已核对，同意' }),
    );

    const passwordHash = await app
      .get(SystemTenantService)
      .passwordHash(password);
    await context.run({ tenantId: tenants[0] }, () =>
      db.transaction(async (manager) => {
        const role = await repos
          .for(SystemRole)
          .query('r', manager)
          .andWhere('r.allPermissions = :all', { all: true })
          .getOneOrFail();
        const userId = await repos.for(SystemUser).insert(
          {
            username: 'global-applicant',
            nickname: '全局授权申请人',
            passwordHash,
            enabled: true,
            defaultOrgId: orgs[0],
            avatar: null,
            locale: 'zh-CN',
          },
          manager,
        );
        await repos
          .for(SystemUserRole)
          .insert({ userId, roleId: role.id, scopeOrgId: null }, manager);
        await repos
          .for(SystemUserSupervisor)
          .insert({ userId, supervisorId: peerId }, manager);
      }),
    );
    const globalToken = await login(0, 'global-applicant');
    const profile = await http()
      .get('/admin/session/profile')
      .set('Authorization', `Bearer ${globalToken}`)
      .expect(200);
    expect(profile.body.data.currentOrg).toBeNull();
    const globalPreview = await post(
      'workflow/definition/available',
      globalToken,
      { id: definition.id },
    ).expect(200);
    expect(globalPreview.body.data.list[0].progress[0].members).toMatchObject([
      { id: peerId },
    ]);
    const globalInstance = await post(
      'workflow/instance/start-application',
      globalToken,
      {
        definitionId: definition.id,
        values: { reason: '无当前组织时使用默认组织负责人' },
      },
    ).expect(200);
    const globalDocument = await post(
      'workflow/instance/document',
      globalToken,
      { id: globalInstance.body.data.id },
    ).expect(200);
    expect(globalDocument.body.data.progress[0]).toMatchObject({
      id: 'lead',
      status: 'pending',
      members: [{ id: peerId }],
    });
  });

  it('AI配置不回传密钥，模板版本不可变，非法变量拒绝', async () => {
    await post('ai/config/save', tokens[0], {
      enabled: true,
      model: 'fixture-model',
      maxOutputTokens: 1024,
      apiKey: 'fixture-api-key-never-real',
      version: 0,
    }).expect(200);
    const config = await http()
      .get('/admin/ai/config')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);
    expect(config.body.data.hasTenantKey).toBe(true);
    expect(JSON.stringify(config.body)).not.toContain('fixture-api-key');
    const templates = await http()
      .get('/admin/ai/template/available')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);
    expect(templates.body.data.list).toHaveLength(3);
    await post('ai/template/save', tokens[0], {
      code: 'generate',
      content: '品牌要求 {{text}} {{instruction}}',
      revision: 0,
    }).expect(200);
    await post('ai/template/save', tokens[0], {
      code: 'generate',
      content: '新版 {{text}}',
      revision: 0,
    }).expect(409);
    await post('ai/template/save', tokens[0], {
      code: 'generate',
      content: '{{text}} {{password}}',
      revision: 1,
    }).expect(400);
  });
  it('AI预占、幂等、真实回执结算、加密草稿和跨租户/无权限拒绝', async () => {
    const key = randomUUID(),
      body = { feature: 'generate', text: '不可出现在历史接口中的测试原文' };
    const submit = () =>
      http()
        .post('/admin/ai/task/submit')
        .set('Authorization', `Bearer ${tokens[0]}`)
        .set('Idempotency-Key', key)
        .send(body);
    const first = await submit().expect(200),
      replay = await submit().expect(200);
    expect(replay.body.data).toEqual(first.body.data);
    const id = first.body.data.id as string;
    const before = await http()
      .get('/admin/ai/task/usage')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);
    expect(BigInt(before.body.data.reservedTokens)).toBeGreaterThan(0n);
    const stored = await context.run({ tenantId: tenants[0] }, () =>
      repos
        .for(AiTask)
        .query('t')
        .addSelect('t.requestCipher')
        .andWhere('t.id=:id', { id })
        .getOneOrFail(),
    );
    expect(stored.requestCipher).not.toContain(body.text);
    await context.run({ tenantId: tenants[0] }, () =>
      app.get(AiService).runPending(),
    );
    const result = await post('ai/task/result', tokens[0], { id }).expect(200);
    expect(result.body.data).toMatchObject({
      status: 'succeeded',
      text: '测试草稿，待人工校对',
    });
    const after = await http()
      .get('/admin/ai/task/usage')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);
    expect(after.body.data).toMatchObject({
      usedTokens: '230',
      reservedTokens: '0',
    });
    const history = await post('ai/task/page', tokens[0], {}).expect(200);
    expect(JSON.stringify(history.body)).not.toMatch(
      /测试原文|测试草稿|requestCipher|resultCipher|keyCipher/,
    );
    await post('ai/task/result', tokens[1], { id }).expect(404);
    await post('ai/task/result', peerToken, { id }).expect(404);
    await post('ai/task/result', limitedToken, { id }).expect(403);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });
  it('AI明确拒绝释放预占，账号停用的排队任务不发给模型', async () => {
    const first = await post('ai/task/submit', tokens[0], {
      feature: 'rewrite',
      text: '明确失败样例',
    }).expect(200);
    provider.generate.mockRejectedValueOnce(new AiProviderFailure(true));
    await context.run({ tenantId: tenants[0] }, () =>
      app.get(AiService).runPending(),
    );
    const failed = await post('ai/task/result', tokens[0], {
      id: first.body.data.id,
    }).expect(200);
    expect(failed.body.data.status).toBe('failed');
    const before = provider.generate.mock.calls.length;
    const second = await post('ai/task/submit', peerToken, {
      feature: 'rewrite',
      text: '账号停用前排队',
    }).expect(200);
    await context.run({ tenantId: tenants[0] }, () =>
      repos.for(SystemUser).update([peerId], { enabled: false }),
    );
    await context.run({ tenantId: tenants[0] }, () =>
      app.get(AiService).runPending(),
    );
    const stopped = await context.run({ tenantId: tenants[0] }, () =>
      repos
        .for(AiTask)
        .query('t')
        .andWhere('t.id=:id', { id: second.body.data.id })
        .getOneOrFail(),
    );
    expect(stopped.status).toBe('failed');
    expect(provider.generate).toHaveBeenCalledTimes(before);
    const usage = await http()
      .get('/admin/ai/task/usage')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);
    expect(usage.body.data.reservedTokens).toBe('0');
  });
  it('AI套餐零配额、并发入队以及计费不确定时不重发并保留预占', async () => {
    const previous = provider.generate.mock.calls.length;
    const setLimit = (limit: number) =>
      context.run({ tenantId: '0' }, () =>
        repos.for(TenantPackage).update([packageId], {
          quotas: Object.assign(new TenantQuotas(), { aiTokensMonthly: limit }),
        }),
      );
    await setLimit(0);
    await post('ai/task/submit', tokens[0], {
      feature: 'rewrite',
      text: '测试内容',
    }).expect(400);
    expect(provider.generate).toHaveBeenCalledTimes(previous);
    await setLimit(3000);
    const responses = await Promise.all([
      post('ai/task/submit', tokens[0], { feature: 'rewrite', text: '并发一' }),
      post('ai/task/submit', tokens[0], { feature: 'rewrite', text: '并发二' }),
    ]);
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 400,
    ]);
    provider.generate.mockRejectedValueOnce(new AiProviderFailure(false));
    await context.run({ tenantId: tenants[0] }, () =>
      app.get(AiService).runPending(),
    );
    const id = responses.find((r) => r.status === 200)!.body.data.id as string;
    const uncertain = await post('ai/task/result', tokens[0], { id }).expect(
      200,
    );
    expect(uncertain.body.data.status).toBe('uncertain');
    const usage = await http()
      .get('/admin/ai/task/usage')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);
    expect(BigInt(usage.body.data.reservedTokens)).toBeGreaterThan(0n);
    await context.run({ tenantId: tenants[0] }, () =>
      app.get(AiService).runPending(),
    );
    expect(provider.generate).toHaveBeenCalledTimes(previous + 1);
    await setLimit(100000);
  });
  it('AI进程中断租约到期只转待核对，不重复调用模型', async () => {
    const first = await post('ai/task/submit', tokens[0], {
      feature: 'generate',
      text: '模拟执行进程中断',
    }).expect(200);
    const count = provider.generate.mock.calls.length;
    await context.run({ tenantId: tenants[0] }, () =>
      repos.for(AiTask).update([first.body.data.id], {
        status: 'running',
        claimToken: randomUUID(),
        leaseUntil: new Date(Date.now() - 1000),
      }),
    );
    await context.run({ tenantId: tenants[0] }, () =>
      app.get(AiService).runPending(),
    );
    const result = await post('ai/task/result', tokens[0], {
      id: first.body.data.id,
    }).expect(200);
    expect(result.body.data.status).toBe('uncertain');
    expect(provider.generate).toHaveBeenCalledTimes(count);
  });
  it('批量原子预占、BullMQ真实调度、SSE结果与一次性账单核对', async () => {
    const first = await post('ai/task/batch', tokens[0], {
      items: [
        { feature: 'generate', text: '批量一' },
        { feature: 'rewrite', text: '批量二' },
      ],
    }).expect(200);
    const ids = first.body.data.ids as string[];
    expect(ids).toHaveLength(2);
    await post('ai/task/batch', tokens[0], {
      items: [
        { feature: 'generate', text: '应回滚' },
        { feature: 'translate', text: '缺少语言' },
      ],
    }).expect(400);
    await context.run({ tenantId: tenants[0] }, () =>
      app.get(AiQueueService).dispatch(),
    );
    await expect
      .poll(
        async () =>
          (await post('ai/task/result', tokens[0], { id: ids[1] }).expect(200))
            .body.data.status,
        { timeout: 10000 },
      )
      .toBe('succeeded');
    const stream = await http()
      .get('/admin/ai/task/events')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .query({ id: ids[0] })
      .expect(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.text).toContain('测试草稿');
    const uncertain = await http()
      .get('/admin/ai/reconciliation/uncertain')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);
    const task = uncertain.body.data.list[0] as { id: string; version: number };
    expect(task).toBeDefined();
    const body = {
      id: task.id,
      version: task.version,
      charged: false,
      inputTokens: 0,
      outputTokens: 0,
      evidence: '测试账单确认未计费',
    };
    await post('ai/reconciliation/settle', tokens[1], body).expect(404);
    await post('ai/reconciliation/settle', tokens[0], body).expect(200);
    await post('ai/reconciliation/settle', tokens[0], body).expect(409);
  }, 20000);
  it('OAuth发现文档、应用登记、PKCE授权及固定租户/组织scope校验', async () => {
    app.get(OAuthRuntimeService).provider();
    const metadata = await http()
      .get('/oauth/.well-known/openid-configuration')
      .expect(200);
    expect(metadata.body.code_challenge_methods_supported).toEqual(['S256']);
    const created = await post('oauth/client/save', tokens[0], {
      name: '测试公共客户端',
      enabled: true,
      authMethod: 'none',
      redirectUris: ['https://client.example/callback'],
      scopes: ['ai:read'],
    }).expect(200);
    oauthClientRow = created.body.data.id as string;
    const info = await post('oauth/client/info', tokens[0], {
      id: oauthClientRow,
    }).expect(200);
    oauthClientId = info.body.data.clientId as string;
    const { result, code, verifier } = await authorizeOAuth();
    oauthAccess = result.body.access_token as string;
    oauthRefresh = result.body.refresh_token as string;
    const ownGrants = await post('oauth/grant/page', tokens[0], {
      keyword: oauthClientId,
      eq: { active: true },
    }).expect(200);
    expect(ownGrants.body.data.total).toBe(1);
    expect(ownGrants.body.data.list[0].clientId).toBe(oauthClientId);
    const otherGrants = await post('oauth/grant/page', tokens[1], {
      keyword: oauthClientId,
    }).expect(200);
    expect(otherGrants.body.data.total).toBe(0);
    expect(oauthAccess.split('.')).toHaveLength(3);
    expect(oauthRefresh).toBeTruthy();
    const principal = await app
      .get(OAuthRuntimeService)
      .runAuthorized(oauthAccess, audience, 'ai:task:info', async () =>
        context.current(),
      );
    expect(principal).toMatchObject({
      tenantId: tenants[0],
      userId: users[0],
      orgId: orgs[0],
    });
    await expect(
      app
        .get(OAuthRuntimeService)
        .runAuthorized(oauthAccess, audience, 'ai:task:add', async () => true),
    ).rejects.toThrow();
    await expect(
      app
        .get(OAuthRuntimeService)
        .runAuthorized(
          oauthAccess,
          'http://127.0.0.1:3012/open',
          'ai:task:info',
          async () => true,
        ),
    ).rejects.toThrow();
    await http()
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: oauthClientId,
        redirect_uri: 'https://client.example/callback',
        code,
        code_verifier: verifier,
        resource: audience,
      })
      .expect(400);
  }, 20000);
  it('OAuth PKCE缺失、回调地址不匹配、本人撤销后旧令牌拒绝', async () => {
    const fresh = await authorizeOAuth();
    const freshAccess = fresh.result.body.access_token as string;
    const without = await http().get('/oauth/authorize').query({
      client_id: oauthClientId,
      redirect_uri: 'https://client.example/callback',
      response_type: 'code',
      scope: 'openid ai:read',
      resource: audience,
    });
    expect([400, 303]).toContain(without.status);
    if (without.status === 303)
      expect(new URL(without.headers.location).searchParams.get('error')).toBe(
        'invalid_request',
      );
    await http()
      .get('/oauth/authorize')
      .query({
        client_id: oauthClientId,
        redirect_uri: 'https://evil.example/callback',
        response_type: 'code',
        scope: 'openid ai:read',
      })
      .expect(400);
    const mine = await http()
      .get('/admin/oauth/grant/mine')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);
    const grant = mine.body.data.list.find(
      (item: { active: boolean }) => item.active,
    ) as { id: string };
    expect(grant).toBeDefined();
    await post('oauth/grant/revoke-mine', tokens[1], { id: grant.id }).expect(
      404,
    );
    await post('oauth/grant/revoke-mine', tokens[0], { id: grant.id }).expect(
      200,
    );
    await expect(
      app
        .get(OAuthRuntimeService)
        .runAuthorized(freshAccess, audience, 'ai:task:info', async () => true),
    ).rejects.toThrow();
  });
  it('OAuth公共客户端DCR与受信CIMD注册及授权', async () => {
    const registered = await http()
      .post('/oauth/register')
      .send({
        client_name: '自动注册测试',
        redirect_uris: ['https://client.example/callback'],
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
        scope: 'openid offline_access ai:read',
      })
      .expect(201);
    expect(registered.body.client_id).toMatch(
      new RegExp('^' + tenants[0] + '\\.'),
    );
    const saved = oauthClientId;
    oauthClientId = 'https://metadata.example/client.json';
    const { result } = await authorizeOAuth();
    expect(result.body.access_token).toBeTruthy();
    oauthClientId = saved;
    const unsafe = await http().get('/oauth/authorize').query({
      client_id: 'https://127.0.0.1/private.json',
      redirect_uri: 'https://client.example/callback',
      response_type: 'code',
      scope: 'openid',
    });
    expect(unsafe.status).toBe(400);
  }, 20000);
  it('OAuth服务账号不能登录，客户端凭证只取得绑定账号的固定组织身份', async () => {
    const service = await post('oauth/service-account/create', tokens[0], {
        name: '测试服务账号',
        orgId: orgs[0],
      }).expect(200),
      serviceId = service.body.data.id as string;
    await context.run({ tenantId: tenants[0] }, () =>
      db.transaction(async (manager) => {
        const grant = await repos
          .for(SystemUserRole)
          .query('r', manager)
          .andWhere('r.userId=:id', { id: users[0] })
          .getOneOrFail();
        await repos
          .for(SystemUserRole)
          .insert(
            { userId: serviceId, roleId: grant.roleId, scopeOrgId: orgs[0] },
            manager,
          );
      }),
    );
    const interactive = await context.run(
      { tenantId: tenants[0] },
      async () => {
        const row = await repos
          .for(SystemUser)
          .query('u')
          .andWhere('u.id=:id', { id: serviceId })
          .getOneOrFail();
        return app.get(AuthUserStore).findForLogin(tenants[0], row.username);
      },
    );
    expect(interactive).toBeNull();
    const secret = 'a1'.repeat(32),
      created = await post('oauth/client/save', tokens[0], {
        name: '测试服务应用',
        enabled: true,
        authMethod: 'client_secret_basic',
        secret,
        redirectUris: ['https://client.example/callback'],
        scopes: ['ai:read'],
        serviceUserId: serviceId,
        serviceOrgId: orgs[0],
      }).expect(200);
    const client = await post('oauth/client/info', tokens[0], {
      id: created.body.data.id,
    }).expect(200);
    expect(JSON.stringify(client.body)).not.toContain(secret);
    const clientId = client.body.data.clientId as string;
    const token = await http()
      .post('/oauth/token')
      .auth(clientId, secret)
      .type('form')
      .send({
        grant_type: 'client_credentials',
        scope: 'ai:read',
        resource: audience,
      });
    if (token.status !== 200)
      throw new Error('客户端凭证响应：' + JSON.stringify(token.body));
    expect(token.body.refresh_token).toBeUndefined();
    const identity = await app
      .get(OAuthRuntimeService)
      .runAuthorized(
        token.body.access_token,
        audience,
        'ai:task:info',
        async () => context.current(),
      );
    expect(identity).toMatchObject({
      userId: serviceId,
      tenantId: tenants[0],
      orgId: orgs[0],
    });
    await app.get(SessionService).revokeUser(tenants[0], serviceId);
    await expect(
      app
        .get(OAuthRuntimeService)
        .runAuthorized(
          token.body.access_token,
          audience,
          'ai:task:info',
          async () => true,
        ),
    ).rejects.toThrow();
  }, 20000);
  it('OAuth私钥签名客户端的并发重放只有一个可换取令牌', async () => {
    const service = await post('oauth/service-account/create', tokens[0], {
        name: '签名测试服务账号',
        orgId: orgs[0],
      }).expect(200),
      serviceId = service.body.data.id as string;
    await context.run({ tenantId: tenants[0] }, () =>
      db.transaction(async (manager) => {
        const grant = await repos
          .for(SystemUserRole)
          .query('r', manager)
          .andWhere('r.userId=:id', { id: users[0] })
          .getOneOrFail();
        await repos
          .for(SystemUserRole)
          .insert(
            { userId: serviceId, roleId: grant.roleId, scopeOrgId: orgs[0] },
            manager,
          );
      }),
    );
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = {
      ...(await exportJWK(publicKey)),
      kid: 'client-fixture',
      alg: 'RS256',
      use: 'sig',
    };
    const created = await post('oauth/client/save', tokens[0], {
      name: '签名客户端',
      enabled: true,
      authMethod: 'private_key_jwt',
      jwks: { keys: [publicJwk] },
      redirectUris: ['https://client.example/callback'],
      scopes: ['ai:read'],
      serviceUserId: serviceId,
      serviceOrgId: orgs[0],
    }).expect(200);
    const client = await post('oauth/client/info', tokens[0], {
        id: created.body.data.id,
      }).expect(200),
      clientId = client.body.data.clientId as string;
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'client-fixture' })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience('http://127.0.0.1:3012/oauth')
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime('1m')
      .sign(privateKey);
    const exchange = () =>
      http().post('/oauth/token').type('form').send({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_assertion_type:
          'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        resource: audience,
        scope: 'ai:read',
      });
    const loaded = await app
      .get(OAuthRuntimeService)
      .provider()
      .Client.find(clientId);
    expect(loaded?.metadata().jwks).toEqual({ keys: [publicJwk] });
    const results = await Promise.all([exchange(), exchange()]);
    if (!results.some((result) => result.status === 200))
      throw new Error(
        '签名认证被拒绝：' +
          JSON.stringify({
            responses: results.map((result) => ({
              status: result.status,
              error: result.body.error,
            })),
          }),
      );
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(
      results.filter((result) => [400, 401].includes(result.status)),
    ).toHaveLength(1);
  }, 20000);
  it('OAuth刷新轮换与旧令牌重用使授权族立即失效', async () => {
    const { result } = await authorizeOAuth();
    const oldRefresh = result.body.refresh_token as string;
    const refreshed = await http()
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: oldRefresh,
        client_id: oauthClientId,
        resource: audience,
      })
      .expect(200);
    expect(refreshed.body.refresh_token).not.toBe(oldRefresh);
    await http()
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: oldRefresh,
        client_id: oauthClientId,
        resource: audience,
      })
      .expect(400);
    await expect(
      app
        .get(OAuthRuntimeService)
        .runAuthorized(
          refreshed.body.access_token,
          audience,
          'ai:task:info',
          async () => true,
        ),
    ).rejects.toThrow();
  }, 20000);
  let mcpToken = '';
  const mcpCall = (
    resource: string,
    action: string,
    input: Record<string, unknown>,
    requestId = randomUUID(),
  ) =>
    app
      .get(OAuthRuntimeService)
      .withDelegation(mcpToken, audience, (identity) =>
        app.get(McpService).call(identity, resource, action, input, requestId),
      );
  async function parameter() {
    const result = await post('system/parameter/add', tokens[0], {
      data: { key: `mcp.${randomUUID()}`, value: '旧值', description: null },
    }).expect(200);
    return result.body.data as { id: string; version: number };
  }
  it('MCP资源发现、真实协议工具与原控制器权限/DTO管道', async () => {
    const challenge = await http().post('/mcp').send({}).expect(401);
    expect(challenge.headers['www-authenticate']).toContain(
      'resource_metadata',
    );
    const metadata = await http()
      .get('/.well-known/oauth-protected-resource/mcp')
      .expect(200);
    expect(metadata.body.resource).toBe(audience);
    await post('mcp/config/save', tokens[0], {
      enabled: true,
      blocked: [],
      confirmPermissions: [],
    }).expect(200);
    const created = await post('oauth/client/save', tokens[0], {
      name: 'MCP测试客户端',
      enabled: true,
      authMethod: 'none',
      redirectUris: ['https://client.example/callback'],
      scopes: ['system:read', 'system:write', 'system:risk', 'ai:read'],
    }).expect(200);
    const info = await post('oauth/client/info', tokens[0], {
      id: created.body.data.id,
    }).expect(200);
    oauthClientId = info.body.data.clientId as string;
    mcpToken = (
      await authorizeOAuth([
        'system:read',
        'system:write',
        'system:risk',
        'ai:read',
      ])
    ).result.body.access_token as string;
    await mcpCall('system.parameter', 'page', { page: 1, size: 5 });
    const result = await http()
      .post('/mcp')
      .set('Authorization', `Bearer ${mcpToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'query',
          arguments: {
            resource: 'system.parameter',
            input: { page: 1, size: 5 },
          },
        },
      })
      .expect(200);
    const message = result.text.includes('data: ')
      ? JSON.parse(
          result.text
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .at(-1)!
            .slice(6),
        )
      : result.body;
    expect(message.result?.isError).not.toBe(true);
    expect(JSON.parse(message.result.content[0].text)).toHaveProperty('list');
    await expect(
      mcpCall('system.parameter', 'add', { data: { key: '', value: 1 } }),
    ).rejects.toThrow();
    await expect(mcpCall('mcp.operation', 'decide', {})).rejects.toThrow();
    await http()
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .send({})
      .expect(401);
    await http()
      .post('/mcp')
      .set('Authorization', `Bearer ${mcpToken}`)
      .set('Origin', 'https://evil.example')
      .send({})
      .expect(403);
  }, 20000);
  it('MCP月度额度在真实工具入口计数，零额度、并发上限、失败调用及租户/月隔离生效', async () => {
    const current = new Date();
    const month = current.toISOString().slice(0, 7);
    const previousMonth = new Date(
      Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1),
    )
      .toISOString()
      .slice(0, 7);
    const original = await context.run({ tenantId: '0' }, () =>
      repos
        .for(TenantPackage)
        .query('p')
        .andWhere('p.id=:id', { id: packageId })
        .getOneOrFail(),
    );
    const usage = (tenantId: string, targetMonth = month) =>
      context.run(
        { tenantId },
        async () =>
          (
            await repos
              .for(McpUsage)
              .query('u')
              .andWhere('u.month=:month', { month: targetMonth })
              .getOne()
          )?.calls ?? 0,
      );
    const setLimit = (limit: number | null) =>
      context.run({ tenantId: '0' }, () =>
        repos.for(TenantPackage).update([packageId], {
          quotas: Object.assign(new TenantQuotas(), original.quotas, {
            mcpCallsMonthly: limit,
          }),
        }),
      );
    const send = async (name = 'list_resources', args = {}) => {
      const result = await http()
        .post('/mcp')
        .set('Authorization', `Bearer ${mcpToken}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'tools/call',
          params: { name, arguments: args },
        })
        .expect(200);
      const message = result.text.includes('data: ')
        ? JSON.parse(
            result.text
              .split('\n')
              .filter((line) => line.startsWith('data: '))
              .at(-1)!
              .slice(6),
          )
        : result.body;
      return message.result as {
        isError?: boolean;
        content: { text: string }[];
      };
    };
    const before = await usage(tenants[0]);
    const otherBefore = await usage(tenants[1]);
    try {
      await context.run({ tenantId: tenants[0] }, () =>
        repos.for(McpUsage).insert({ month: previousMonth, calls: 9999 }),
      );
      await setLimit(0);
      const denied = await send();
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toContain('MCP月度调用上限');
      expect(await usage(tenants[0])).toBe(before);
      await setLimit(null);
      expect((await send()).isError).not.toBe(true);
      expect(await usage(tenants[0])).toBe(before + 1);
      await setLimit(before + 2);
      const concurrent = await Promise.all([send(), send()]);
      expect(
        concurrent.filter((result) => result.isError !== true),
      ).toHaveLength(1);
      expect(
        concurrent.filter((result) => result.isError === true),
      ).toHaveLength(1);
      expect(await usage(tenants[0])).toBe(before + 2);
      await setLimit(null);
      const failed = await send('query', {
        resource: 'missing.resource',
        input: {},
      });
      expect(failed.isError).toBe(true);
      expect(await usage(tenants[0])).toBe(before + 3);
      expect(await usage(tenants[0], previousMonth)).toBe(9999);
      expect(await usage(tenants[1])).toBe(otherBefore);
    } finally {
      await context.run({ tenantId: '0' }, () =>
        repos
          .for(TenantPackage)
          .update([packageId], { quotas: original.quotas }),
      );
    }
  });

  it('MCP新版URL询问只引导后台，伪造客户端accept不能执行', async () => {
    const target = await parameter(),
      requestId = randomUUID();
    const requestBody = (responses?: object) => ({
      jsonrpc: '2.0',
      id: 71,
      method: 'tools/call',
      params: {
        name: 'delete',
        arguments: {
          resource: 'system.parameter',
          input: { ids: [target.id] },
          requestId,
        },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: '验收替身',
            version: '1',
          },
          'io.modelcontextprotocol/clientCapabilities': {
            elicitation: { url: {} },
          },
        },
        ...(responses ? { inputResponses: responses } : {}),
      },
    });
    const send = (body: object) =>
      http()
        .post('/mcp')
        .set('Authorization', `Bearer ${mcpToken}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', '2026-07-28')
        .set('Mcp-Method', 'tools/call')
        .set('Mcp-Name', 'delete')
        .send(body);
    const first = await send(requestBody());
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.result?.resultType).toBe('input_required');
    expect(first.body.result?.inputRequests?.confirm).toBeDefined();
    await send(requestBody({ confirm: { action: 'accept' } })).expect(200);
    await post('system/parameter/info', tokens[0], { id: target.id }).expect(
      200,
    );
  });
  it('MCP低风险写入同事务登记、同键重试只返回回执且不重复写', async () => {
    const key = randomUUID(),
      input = {
        data: {
          key: `mcp.${randomUUID()}`,
          value: '不可重复',
          description: null,
        },
      };
    const first = await mcpCall('system.parameter', 'add', input, key);
    expect(first).toMatchObject({
      status: 'succeeded',
      result: { completed: true },
    });
    expect(await mcpCall('system.parameter', 'add', input, key)).toEqual(first);
    await expect(
      mcpCall(
        'system.parameter',
        'add',
        { ...input, data: { ...input.data, value: '篡改' } },
        key,
      ),
    ).rejects.toThrow();
  });
  it('MCP高风险待确认、异人/跨租户拒绝，本人确认一次执行', async () => {
    const target = await parameter();
    const pending = (await mcpCall('system.parameter', 'delete', {
      ids: [target.id],
    })) as { operationId: string; status: string };
    expect(pending.status).toBe('pending');
    const operationList = await post('mcp/operation-list/page', tokens[0], {
      keyword: 'system.parameter',
      eq: { action: 'delete' },
      page: 1,
      size: 1,
    }).expect(200);
    expect(operationList.body.data.total).toBeGreaterThan(0);
    expect(operationList.body.data.list).toHaveLength(1);
    expect(operationList.body.data.list[0].id).toBe(pending.operationId);
    expect(operationList.body.data.list[0].status).toBe('pending');
    for (const field of [
      'payloadCipher',
      'receipt',
      'grantId',
      'requestHash',
      'digest',
    ])
      expect(operationList.body.data.list[0]).not.toHaveProperty(field);
    await post('mcp/operation-list/info', tokens[1], {
      id: pending.operationId,
    }).expect(404);
    await post('mcp/operation-list/page', limitedToken, {}).expect(403);
    await http()
      .get('/admin/mcp/operation/mine')
      .set('Authorization', `Bearer ${limitedToken}`)
      .expect(200);
    const otherOperations = await post(
      'mcp/operation-list/page',
      tokens[1],
      {},
    ).expect(200);
    expect(otherOperations.body.data.total).toBe(0);
    await post('mcp/operation-list/update', tokens[0], {}).expect(404);
    await post('system/parameter/info', tokens[0], { id: target.id }).expect(
      200,
    );
    await post('mcp/operation/decide', limitedToken, {
      id: pending.operationId,
      approve: true,
    }).expect(404);
    await post('mcp/operation/decide', tokens[1], {
      id: pending.operationId,
      approve: true,
    }).expect(404);
    const confirms = await Promise.all([
      post('mcp/operation/decide', tokens[0], {
        id: pending.operationId,
        approve: true,
      }),
      post('mcp/operation/decide', tokens[0], {
        id: pending.operationId,
        approve: true,
      }),
    ]);
    expect(confirms.some((result) => result.status === 200)).toBe(true);
    expect(confirms.every((result) => [200, 409].includes(result.status))).toBe(
      true,
    );
    await post('system/parameter/info', tokens[0], { id: target.id }).expect(
      404,
    );
    const repeat = await post('mcp/operation/decide', tokens[0], {
      id: pending.operationId,
      approve: true,
    }).expect(200);
    expect(repeat.body.data.status).toBe('succeeded');
  });
  it('MCP目标版本变化/过期/拒绝均不能继续执行', async () => {
    const target = await parameter();
    const pending = (await mcpCall('system.parameter', 'delete', {
      ids: [target.id],
    })) as { operationId: string };
    await post('system/parameter/update', tokens[0], {
      id: target.id,
      version: target.version,
      data: { value: '已更新' },
    }).expect(200);
    await post('mcp/operation/decide', tokens[0], {
      id: pending.operationId,
      approve: true,
    }).expect(409);
    await post('system/parameter/info', tokens[0], { id: target.id }).expect(
      200,
    );
    const expired = (await mcpCall('system.parameter', 'delete', {
      ids: [target.id],
    })) as { operationId: string };
    await context.run({ tenantId: tenants[0] }, () =>
      repos.for(McpOperation).update([expired.operationId], {
        expiresAt: new Date(Date.now() - 1000),
      }),
    );
    const expiredView = await post('mcp/operation-list/info', tokens[0], {
      id: expired.operationId,
    }).expect(200);
    expect(expiredView.body.data.status).toBe('expired');
    const unchanged = await context.run({ tenantId: tenants[0] }, () =>
      repos
        .for(McpOperation)
        .query('o')
        .andWhere('o.id=:id', { id: expired.operationId })
        .getOneOrFail(),
    );
    expect(unchanged.status).toBe('pending');
    await post('mcp/operation/decide', tokens[0], {
      id: expired.operationId,
      approve: true,
    }).expect(409);
    const rejected = (await mcpCall('system.parameter', 'delete', {
      ids: [target.id],
    })) as { operationId: string };
    await post('mcp/operation/decide', tokens[0], {
      id: rejected.operationId,
      approve: false,
    }).expect(200);
    const denied = await post('mcp/operation/decide', tokens[0], {
      id: rejected.operationId,
      approve: true,
    }).expect(200);
    expect(denied.body.data.status).toBe('rejected');
    await post('system/parameter/info', tokens[0], { id: target.id }).expect(
      200,
    );
  });
  it('MCP服务账号指定真人确认、精确免确认审计提醒与撤销即时生效', async () => {
    const service = await post('oauth/service-account/create', tokens[0], {
        name: 'MCP服务',
        orgId: orgs[0],
      }).expect(200),
      serviceId = service.body.data.id as string;
    await context.run({ tenantId: tenants[0] }, () =>
      db.transaction(async (manager) => {
        const role = await repos
          .for(SystemUserRole)
          .query('r', manager)
          .andWhere('r.userId=:id', { id: users[0] })
          .getOneOrFail();
        await repos
          .for(SystemUserRole)
          .insert(
            { userId: serviceId, roleId: role.roleId, scopeOrgId: orgs[0] },
            manager,
          );
      }),
    );
    const secret = 'b2'.repeat(32),
      created = await post('oauth/client/save', tokens[0], {
        name: 'MCP服务应用',
        enabled: true,
        authMethod: 'client_secret_basic',
        secret,
        redirectUris: ['https://client.example/callback'],
        scopes: ['system:read', 'system:risk'],
        serviceUserId: serviceId,
        serviceOrgId: orgs[0],
      }).expect(200);
    const client = await post('oauth/client/info', tokens[0], {
        id: created.body.data.id,
      }).expect(200),
      clientId = client.body.data.clientId as string;
    const token = await http()
      .post('/oauth/token')
      .auth(clientId, secret)
      .type('form')
      .send({
        grant_type: 'client_credentials',
        scope: 'system:read system:risk',
        resource: audience,
      })
      .expect(200);
    const call = (id: string) =>
      app
        .get(OAuthRuntimeService)
        .withDelegation(token.body.access_token, audience, (identity) =>
          app
            .get(McpService)
            .call(
              identity,
              'system.parameter',
              'delete',
              { ids: [id] },
              randomUUID(),
            ),
        );
    const target = await parameter();
    await expect(call(target.id)).rejects.toThrow('审批人');
    await post('mcp/config/delegation', tokens[0], {
      clientId,
      approverId: users[0],
    }).expect(200);
    const pending = (await call(target.id)) as {
      status: string;
      operationId: string;
    };
    expect(pending.status).toBe('pending');
    await post('mcp/operation/decide', tokens[0], {
      id: pending.operationId,
      approve: true,
    }).expect(200);
    await post('mcp/config/delegation', tokens[0], {
      clientId,
      approverId: users[0],
      permission: 'system:parameter:delete',
      enabled: true,
    }).expect(200);
    const exemptTarget = await parameter(),
      executed = (await call(exemptTarget.id)) as {
        status: string;
        operationId: string;
      };
    expect(executed.status).toBe('succeeded');
    const notice = await context.run({ tenantId: tenants[0] }, () =>
      repos
        .for(NotifyMessage)
        .query('n')
        .andWhere('n.eventKey=:key', {
          key: `mcp-exempt:${executed.operationId}`,
        })
        .getOne(),
    );
    expect(notice?.recipientId).toBe(users[0]);
    await post('mcp/config/delegation', tokens[0], {
      clientId,
      approverId: users[0],
      permission: 'system:parameter:delete',
      enabled: false,
    }).expect(200);
    const next = await parameter();
    expect(await call(next.id)).toMatchObject({ status: 'pending' });
    await post('system/parameter/info', tokens[0], { id: next.id }).expect(200);
  }, 20000);
  it('MCP策略关闭和追加确认实时生效，不能由工具移除风险', async () => {
    await post('mcp/config/save', tokens[0], {
      enabled: true,
      blocked: [],
      confirmPermissions: ['system:parameter:add'],
    }).expect(200);
    const pending = (await mcpCall('system.parameter', 'add', {
      data: { key: `mcp.${randomUUID()}`, value: '需确认' },
    })) as { operationId: string; status: string };
    expect(pending.status).toBe('pending');
    await post('mcp/config/save', tokens[0], {
      enabled: true,
      blocked: ['system'],
      confirmPermissions: [],
    }).expect(200);
    await post('mcp/operation/decide', tokens[0], {
      id: pending.operationId,
      approve: true,
    }).expect(403);
    await expect(mcpCall('system.parameter', 'page', {})).rejects.toThrow();
    await post('mcp/config/save', tokens[0], {
      enabled: true,
      blocked: [],
      confirmPermissions: [],
    }).expect(200);
  });
  it('MCP准入、字段隐藏和本人数据范围与后台一致，收回准入立即拒绝', async () => {
    const codes = [
      'system:parameter:page',
      'system:parameter:info',
      'form:submission:page',
    ];
    const roleId = await context.run({ tenantId: tenants[0] }, async () => {
      const role = await repos
        .for(SystemRole)
        .query('r')
        .andWhere('r.code=:code', { code: 'limited' })
        .getOneOrFail();
      await repos.for(SystemRole).update([role.id], { permissions: codes });
      await repos.for(SystemRoleField).insert({
        roleId: role.id,
        resource: 'system:parameter',
        field: 'value',
        state: 'hidden',
        mask: null,
      });
      await app.get(PermissionService).bumpVersion(tenants[0]);
      return role.id;
    });
    const created = await post('oauth/client/save', tokens[0], {
      name: '受限MCP应用',
      enabled: true,
      authMethod: 'none',
      redirectUris: ['https://client.example/callback'],
      scopes: ['system:read', 'form:read'],
    }).expect(200);
    oauthClientId = (
      await post('oauth/client/info', tokens[0], {
        id: created.body.data.id,
      }).expect(200)
    ).body.data.clientId as string;
    const token = (
      await authorizeOAuth(['system:read', 'form:read'], limitedToken)
    ).result.body.access_token as string;
    const call = (resource: string, action: string, input = {}) =>
      app
        .get(OAuthRuntimeService)
        .withDelegation(token, audience, (identity) =>
          app.get(McpService).call(identity, resource, action, input),
        );
    await expect(call('system.parameter', 'page')).rejects.toThrow();
    await context.run({ tenantId: tenants[0] }, async () => {
      await repos
        .for(SystemRole)
        .update([roleId], { permissions: [...codes, 'mcp:use'] });
      await app.get(PermissionService).bumpVersion(tenants[0]);
    });
    const target = await parameter(),
      row = await call('system.parameter', 'info', { id: target.id });
    const restrictedOperations = await post(
      'mcp/operation-list/page',
      limitedToken,
      {},
    ).expect(200);
    expect(restrictedOperations.body.data.total).toBe(0);
    const assigned = (await mcpCall('system.parameter', 'delete', {
      ids: [target.id],
    })) as { operationId: string };
    const maskedField = await context.run({ tenantId: tenants[0] }, () =>
      db.transaction(async (manager) => {
        const viewer = await repos
          .for(SystemUser)
          .query('u', manager)
          .andWhere('u.username=:name', { name: 'limited' })
          .getOneOrFail();
        await repos
          .for(McpOperation)
          .update([assigned.operationId], { approverId: viewer.id }, manager);
        return repos.for(SystemRoleField).insert(
          {
            roleId,
            resource: 'mcp:operation-list',
            field: 'status',
            state: 'masked',
            mask: 'all',
          },
          manager,
        );
      }),
    );
    await app.get(PermissionService).bumpVersion(tenants[0]);
    try {
      const assignedView = await post('mcp/operation-list/info', limitedToken, {
        id: assigned.operationId,
      }).expect(200);
      expect(assignedView.body.data._fieldState.status).toBe('masked');
      expect(assignedView.body.data.status).not.toBe('pending');
      expect(assignedView.body.data).not.toHaveProperty('payloadCipher');
    } finally {
      await context.run({ tenantId: tenants[0] }, () =>
        repos.for(SystemRoleField).remove([maskedField]),
      );
      await app.get(PermissionService).bumpVersion(tenants[0]);
    }
    expect(row).not.toHaveProperty('value');
    expect(
      JSON.stringify(await call('system.parameter', 'schema')),
    ).not.toContain('"field":"value"');
    expect(await call('form.submission', 'page')).toMatchObject({
      list: [],
      total: 0,
    });
    await context.run({ tenantId: tenants[0] }, async () => {
      await repos.for(SystemRole).update([roleId], { permissions: codes });
      await app.get(PermissionService).bumpVersion(tenants[0]);
    });
    await expect(call('system.parameter', 'page')).rejects.toThrow();
  }, 20000);
  it('租户系统对接自动绑定服务身份和角色，无回调即可换取独立凭据令牌', async () => {
    const roleId = await context.run(
      { tenantId: tenants[0] },
      async () =>
        (
          await repos
            .for(SystemRole)
            .query('r')
            .andWhere('r.code=:code', { code: 'limited' })
            .getOneOrFail()
        ).id,
    );
    const secret = 'd4'.repeat(32),
      body = {
        name: '自动身份ERP',
        enabled: true,
        orgId: orgs[0],
        roleIds: [roleId],
        secret,
      },
      key = randomUUID();
    const save = () =>
      http()
        .post('/admin/oauth/client/integration-save')
        .set('Authorization', `Bearer ${tokens[0]}`)
        .set('Idempotency-Key', key)
        .send(body);
    const result = await save().expect(200),
      repeated = await save().expect(200);
    expect(repeated.body).toEqual(result.body);
    expect(JSON.stringify(result.body)).not.toContain(secret);
    const id = result.body.data.id as string;
    const info = await http()
      .get('/admin/oauth/client/integration')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .query({ id })
      .expect(200);
    expect(info.body.data).toMatchObject({
      roleIds: [roleId],
      orgId: orgs[0],
      scopes: ['form:read', 'system:read'],
    });
    const client = await post('oauth/client/info', tokens[0], { id }).expect(
        200,
      ),
      clientId = info.body.data.clientId as string;
    expect(client.body.data.redirectUris).toEqual([]);
    expect(client.body.data.serviceUserId).toBeTruthy();
    await http()
      .get('/admin/oauth/client/integration')
      .set('Authorization', `Bearer ${tokens[1]}`)
      .query({ id })
      .expect(404);
    const issue = (credential: string) =>
      http().post('/oauth/token').auth(clientId, credential).type('form').send({
        grant_type: 'client_credentials',
        scope: 'system:read',
        resource: audience,
      });
    const token = await issue(secret).expect(200);
    expect(token.body.refresh_token).toBeUndefined();
    await app
      .get(OAuthRuntimeService)
      .runAuthorized(
        token.body.access_token,
        audience,
        'system:parameter:info',
        async () => {
          expect(context.current()).toMatchObject({
            tenantId: tenants[0],
            userId: client.body.data.serviceUserId,
            orgId: orgs[0],
          });
        },
      );
    await http()
      .get('/oauth/authorize')
      .query({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: 'https://client.example/callback',
        scope: 'openid',
      })
      .expect(400);
    const newSecret = 'e5'.repeat(32);
    await post('oauth/client/integration-save', tokens[0], {
      ...body,
      id,
      version: info.body.data.version,
      secret: newSecret,
    }).expect(200);
    const updated = await post('oauth/client/info', tokens[0], { id }).expect(
      200,
    );
    expect(updated.body.data.serviceUserId).toBe(
      client.body.data.serviceUserId,
    );
    await issue(secret).expect(401);
    await issue(newSecret).expect(200);
    await expect(
      app
        .get(OAuthRuntimeService)
        .runAuthorized(
          token.body.access_token,
          audience,
          'system:parameter:info',
          async () => true,
        ),
    ).rejects.toThrow();
  }, 20000);
  it('自动身份拒绝超级管理员/跨租户角色，失败不遗留账号或应用', async () => {
    const counts = () =>
      context.run({ tenantId: tenants[0] }, async () => ({
        users: await repos.for(SystemUser).query('u').getCount(),
        clients: await repos.for(OAuthClient).query('c').getCount(),
      }));
    const before = await counts();
    const ownAdmin = await context.run(
      { tenantId: tenants[0] },
      async () =>
        (
          await repos
            .for(SystemRole)
            .query('r')
            .andWhere('r.allPermissions=1')
            .getOneOrFail()
        ).id,
    );
    const otherAdmin = await context.run(
      { tenantId: tenants[1] },
      async () =>
        (
          await repos
            .for(SystemRole)
            .query('r')
            .andWhere('r.allPermissions=1')
            .getOneOrFail()
        ).id,
    );
    const body = {
      name: '不应保留',
      enabled: true,
      orgId: orgs[0],
      roleIds: [ownAdmin],
      secret: 'f6'.repeat(32),
    };
    await post('oauth/client/integration-save', tokens[0], body).expect(400);
    await post('oauth/client/integration-save', tokens[0], {
      ...body,
      roleIds: [otherAdmin],
    }).expect(400);
    await post('oauth/client/integration-save', tokens[0], {
      ...body,
      roleIds: ['999999999999999999'],
    }).expect(400);
    expect(await counts()).toEqual(before);
  });
});
