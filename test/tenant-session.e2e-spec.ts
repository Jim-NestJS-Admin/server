import { Get, Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  AdminController,
  IgnoreTenant,
} from '../src/core/endpoint/endpoint.decorators.js';
import { Perms } from '../src/core/permission/perms.decorator.js';
import { PermissionRegistry } from '../src/core/permission/permission-registry.js';
import { PermissionService } from '../src/core/permission/permission.service.js';
import { SessionService } from '../src/core/auth/session.service.js';
import { RequestContext } from '../src/core/tenant/request-context.js';
import { TenantSource } from '../src/core/tenant/tenant-source.js';
import { TenantRepositoryFactory } from '../src/core/tenant/tenant-repository.js';
import { PlatformAuditSink } from '../src/core/tenant/platform-context.js';
import { SystemPlatformAuditSink } from '../src/modules/system-log/service/platform-audit.service.js';
import { SystemTenantService } from '../src/modules/system/service/system-tenant.service.js';
import {
  SystemMenu,
  SystemOrg,
} from '../src/modules/system/entity/system.entity.js';
import {
  SystemTenant,
  TenantPackage,
  TenantQuotas,
} from '../src/modules/tenant/entity/tenant.entity.js';
import { rawRedis, clearTestRedis } from './support/test-redis.js';

@Injectable()
@AdminController('platform/tenant-test')
class ReadOnlyProbe {
  constructor(private readonly repos: TenantRepositoryFactory) {}
  @Get('permission')
  @Perms('platform:tenant:info')
  permission() {
    return '仅平台权限';
  }
  @Get('write')
  @IgnoreTenant()
  @Perms('platform:tenant:info')
  write() {
    return this.repos
      .for(SystemOrg)
      .insert({ name: '禁止写入', enabled: true });
  }
}

/** 不替换认证、租户目录、系统权限、验证码或会话；通过真实出题/Redis答案完成测试登录。 */
describe('T32 真实多租户认证和权限失效', () => {
  let app: INestApplication<App>,
    ds: DataSource,
    ctx: RequestContext,
    repos: TenantRepositoryFactory;
  let tenants: string[], orgs: string[], packageId: string;
  let menuIds: string[];
  const raw = rawRedis();
  const codes = ['default', 'demo'];
  const origin = 'http://localhost:8848';
  const password = 'StrongPassword8';
  const http = () => request(app.getHttpServer());
  const bearer = (r: request.Test, token: string) =>
    r.set('Authorization', `Bearer ${token}`);
  const profile = (token: string) =>
    bearer(http().get('/admin/session/profile'), token);
  const authPost = (path: string, token: string, body: object) =>
    bearer(http().post('/admin/' + path), token).send(body);
  const challenge = async (code: string, tenant: string) => {
    const res = await http()
      .get('/admin/auth/captcha')
      .set('X-Tenant-Code', code)
      .query({ purpose: 'login', account: 'admin' })
      .expect(200);
    const captchaId = res.body.data.captchaId as string;
    const saved = await raw.get(
      `jna-test:t:${tenant}:auth:captcha:${captchaId}`,
    );
    expect(saved).not.toBeNull();
    return {
      captchaId,
      captchaCode: (JSON.parse(saved!) as { answer: string }).answer,
    };
  };
  const signIn = async (index: number | 'platform') => {
    const code = index === 'platform' ? 'platform' : codes[index];
    const tenant = index === 'platform' ? '0' : tenants[index];
    const captcha = await challenge(code, tenant);
    const res = await http()
      .post('/admin/auth/login')
      .set('X-Tenant-Code', code)
      .send({ username: 'admin', password, ...captcha })
      .expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    return {
      token: res.body.data.accessToken as string,
      cookie: cookies.find((c) => c.startsWith('jna_rt='))!.split(';')[0],
    };
  };
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ReadOnlyProbe],
    }).compile();
    app = m.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    ctx = app.get(RequestContext);
    repos = app.get(TenantRepositoryFactory);
    if (ds.options.database !== 'jim_admin_integration_20261109_test')
      throw Error('只允许独立测试库');
  });
  afterAll(async () => {
    await raw.quit();
    await app?.close();
  });
  beforeEach(async () => {
    if (ds.options.database !== 'jim_admin_integration_20261109_test')
      throw Error('拒绝清理其他数据库');
    for (const table of [
      'sys_user_role',
      'sys_user_supervisor',
      'sys_user',
      'sys_role',
      'sys_org',
      'sys_menu',
      'sys_operation_log',
      'sys_field',
      'sys_role_field',
    ])
      await ds.query(`DELETE FROM ${table}`);
    await ds.query('TRUNCATE TABLE sys_tenant');
    await ds.query('TRUNCATE TABLE sys_package');
    await clearTestRedis(raw);
    const system = app.get(SystemTenantService),
      hash = await system.passwordHash(password);
    tenants = [];
    orgs = [];
    menuIds = [];
    await ctx.run({ tenantId: '0' }, () =>
      ds.transaction(async (manager) => {
        for (const p of app.get(PermissionRegistry).all()) {
          menuIds.push(
            await repos.for(SystemMenu).insert(
              {
                type: 'page',
                scope:
                  p.code.startsWith('platform:') ||
                  p.code.startsWith('system:menu:')
                    ? 'platform'
                    : 'tenant',
                title: p.code,
                path: '/probe/' + menuIds.length,
                parentId: null,
                component: null,
                permission: p.code,
                rank: 0,
                hidden: false,
                keepAlive: false,
              },
              manager,
            ),
          );
        }
        const usable = (await system.platformMenus(manager))
          .filter((m) => m.scope === 'tenant')
          .map((m) => m.id);
        packageId = await repos.for(TenantPackage).insert(
          {
            code: 'all',
            name: '全部',
            menuIds: usable,
            quotas: new TenantQuotas(),
            enabled: true,
          },
          manager,
        );
        for (const code of codes)
          tenants.push(
            await repos.for(SystemTenant).insert(
              {
                code,
                name: code,
                packageId,
                domains: [code + '.example.test'],
                enabled: true,
              },
              manager,
            ),
          );
        await system.initialize(
          manager,
          '平台',
          'admin',
          hash,
          'platform_admin',
        );
      }),
    );
    for (const tenantId of tenants)
      await ctx.run({ tenantId }, () =>
        ds.transaction(async (manager) => {
          await system.initialize(manager, '测试组织', 'admin', hash);
          orgs.push(
            (await repos.for(SystemOrg).query('o', manager).getOneOrFail()).id,
          );
        }),
      );
  });

  for (const index of [0, 1]) {
    const other = 1 - index;
    it(`${codes[index]} → ${codes[other]}：真实令牌、域名、刷新、组织、资源均隔离`, async () => {
      const a = await signIn(index),
        b = await signIn(other);
      const own = await profile(a.token).expect(200);
      expect(own.body.data.tenant.id).toBe(tenants[index]);
      await profile(a.token).set('X-Tenant-Code', codes[other]).expect(200);
      await profile(a.token)
        .set('Host', codes[other] + '.example.test')
        .expect(401);
      await profile(a.token)
        .set('Host', codes[index] + '.example.test')
        .expect(200);
      await http()
        .post('/admin/auth/refresh')
        .set('Origin', origin)
        .set('X-Tenant-Code', codes[other])
        .set('Cookie', a.cookie)
        .expect(401);
      await http()
        .post('/admin/auth/refresh')
        .set('Origin', origin)
        .set('X-Tenant-Code', codes[index])
        .set('Cookie', a.cookie)
        .expect(200);
      await authPost('session/switch-org', b.token, { orgId: orgs[index] })
        .set('Origin', origin)
        .expect(403);
      await authPost('system/org/info', b.token, { id: orgs[index] }).expect(
        404,
      );
      const page = await authPost('system/org/page', b.token, {}).expect(200);
      expect(
        page.body.data.list.map((x: { id: string }) => x.id),
      ).not.toContain(orgs[index]);
    });
    it(`${codes[index]} → ${codes[other]}：验证码不能换租户，域名优先且冲突拒绝`, async () => {
      const captcha = await challenge(codes[index], tenants[index]);
      await http()
        .post('/admin/auth/login')
        .set('X-Tenant-Code', codes[other])
        .send({ username: 'admin', password, ...captcha })
        .expect(400);
      await http()
        .post('/admin/auth/login')
        .set('X-Tenant-Code', codes[index])
        .send({ username: 'admin', password, ...captcha })
        .expect(200);
      const hint = await http()
        .get('/admin/auth/tenant-hint')
        .set('Host', codes[index] + '.example.test')
        .expect(200);
      expect(hint.body.data).toEqual({
        mode: 'domain',
        tenant: { code: codes[index], name: codes[index] },
      });
      await http()
        .post('/admin/auth/login')
        .set('Host', codes[index] + '.example.test')
        .set('X-Tenant-Code', codes[other])
        .send({ username: 'admin', password })
        .expect(400);
    });
    it(`${codes[index]}：停用、过期、删除让已有会话与刷新立即失效`, async () => {
      for (const change of [
        { enabled: false },
        { enabled: true, expiresAt: new Date(Date.now() - 1000) },
        { enabled: true, expiresAt: null, deletedAt: new Date() },
      ]) {
        const a = await signIn(index);
        if ('deletedAt' in change) {
          const platform = await signIn('platform');
          await authPost('platform/tenant/delete', platform.token, {
            ids: [tenants[index]],
          }).expect(200);
        } else {
          await ctx.run({ tenantId: '0' }, () =>
            repos.for(SystemTenant).update([tenants[index]], change),
          );
        }
        await profile(a.token).expect(401);
        await http()
          .post('/admin/auth/refresh')
          .set('Origin', origin)
          .set('X-Tenant-Code', codes[index])
          .set('Cookie', a.cookie)
          .expect(401);
        await ctx.run({ tenantId: '0' }, () =>
          repos.for(SystemTenant).update([tenants[index]], {
            enabled: true,
            expiresAt: null,
          }),
        );
      }
    });
  }
  it('未知/停用租户与密码错误返回同样登录错误', async () => {
    const captcha = await challenge('default', tenants[0]);
    const wrong = await http()
      .post('/admin/auth/login')
      .set('X-Tenant-Code', 'default')
      .send({ username: 'admin', password: 'wrong', ...captcha })
      .expect(400);
    for (const code of ['missing', 'demo']) {
      await ctx.run({ tenantId: '0' }, () =>
        repos.for(SystemTenant).update([tenants[1]], { enabled: false }),
      );
      const ownChallenge = await challenge(code, '18446744073709551615');
      const r = await http()
        .post('/admin/auth/login')
        .set('X-Tenant-Code', code)
        .send({ username: 'admin', password, ...ownChallenge })
        .expect(400);
      expect({ code: r.body.code, message: r.body.message }).toEqual({
        code: wrong.body.code,
        message: wrong.body.message,
      });
    }
  });
  it('T30回归：默认租户停用后，不带租户编码也不能刷新', async () => {
    const a = await signIn(0);
    await ctx.run({ tenantId: '0' }, () =>
      repos.for(SystemTenant).update([tenants[0]], { enabled: false }),
    );
    await http()
      .post('/admin/auth/refresh')
      .set('Origin', origin)
      .set('Cookie', a.cookie)
      .expect(401);
  });
  // 此项只将契约允许的packageMenuIds(null)来源代入，真实令牌/角色/权限守卫仍全部执行。
  it('T30回归：不限套餐的租户超管仍不能访问平台权限码', async () => {
    const a = await signIn(0);
    const spy = vi
      .spyOn(app.get(TenantSource), 'packageMenuIds')
      .mockResolvedValue(null);
    try {
      await app.get(PermissionService).bumpVersion(tenants[0]);
      await bearer(
        http().get('/admin/platform/tenant-test/permission'),
        a.token,
      ).expect(403);
    } finally {
      spy.mockRestore();
    }
  });
  it('套餐收窄使已有令牌权限失效，租户超管不能授予套餐外和平台权限', async () => {
    const a = await signIn(0),
      platform = await signIn('platform');
    await authPost('system/org/page', a.token, {}).expect(200);
    const info = await authPost('platform/package/info', platform.token, {
      id: packageId,
    }).expect(200);
    const narrow = menuIds.filter(
      (_id, i) =>
        !['system:org:page', 'system:org:info'].includes(
          app.get(PermissionRegistry).all()[i].code,
        ),
    );
    // 平台菜单也不可出现在套餐中。
    const usable = await ctx.run({ tenantId: '0' }, () =>
      app.get(SystemTenantService).platformMenus(),
    );
    await authPost('platform/package/update', platform.token, {
      id: packageId,
      version: info.body.data.version,
      data: {
        menuIds: narrow.filter(
          (id) => usable.find((m) => m.id === id)?.scope === 'tenant',
        ),
      },
    }).expect(200);
    await authPost('system/org/page', a.token, {}).expect(403);
    for (const permission of ['system:org:page', 'platform:tenant:page'])
      await authPost('system/role/add', a.token, {
        data: {
          name: '越权',
          code: 'denied',
          enabled: true,
          permissions: [permission],
          allPermissions: false,
          dataScope: 'all',
        },
      }).expect(400);
    const menus = await bearer(
      http().get('/admin/session/menu'),
      a.token,
    ).expect(200);
    expect(menus.body.data.permissions).not.toContain('system:org:page');
    expect(
      menus.body.data.permissions.some((p: string) =>
        p.startsWith('platform:'),
      ),
    ).toBe(false);
  });
  it('真实租户令牌不能访问平台/菜单；平台只读有目标审计，写入和审计失败拒绝', async () => {
    for (const i of [0, 1]) {
      const a = await signIn(i);
      for (const path of [
        'platform/tenant/page',
        'platform/package/page',
        'system/menu/page',
      ])
        await authPost(path, a.token, {}).expect(403);
    }
    const p = await signIn('platform');
    await authPost('platform/tenant/usage', p.token, { id: tenants[0] }).expect(
      200,
    );
    const audit = (await ds.query(
      "SELECT snapshot FROM sys_operation_log WHERE action='platform:cross-tenant-read'",
    )) as { snapshot: unknown }[];
    expect(
      audit.some((x) =>
        JSON.stringify(x.snapshot).includes(`"targetTenantId":"${tenants[0]}"`),
      ),
    ).toBe(true);
    const before = await ds.query('SELECT COUNT(*) AS n FROM sys_org');
    await bearer(
      http().get('/admin/platform/tenant-test/write'),
      p.token,
    ).expect(500);
    expect(await ds.query('SELECT COUNT(*) AS n FROM sys_org')).toEqual(before);
    const sink = app.get(PlatformAuditSink);
    expect(sink).toBeInstanceOf(SystemPlatformAuditSink);
    const spy = vi
      .spyOn(sink, 'record')
      .mockRejectedValueOnce(new Error('审计故障'));
    try {
      await authPost('platform/tenant/usage', p.token, {
        id: tenants[0],
      }).expect(503);
    } finally {
      spy.mockRestore();
    }
  });
  it('相同用户编号的租户会话、权限缓存与授权版本互不污染', async () => {
    const sessions = app.get(SessionService),
      perms = app.get(PermissionService);
    const create = (tenantId: string) =>
      sessions.create({
        tenantId,
        userId: '999999',
        orgId: null,
        ip: '127.0.0.1',
        userAgent: 'T32',
        expectedEpoch: 0,
      });
    const a = (await create(tenants[0]))!,
      b = (await create(tenants[1]))!;
    expect(
      await sessions.verify(tenants[1], a.session.sessionId, '999999', 1),
    ).toBeNull();
    await sessions.revokeUser(tenants[0], '999999');
    expect(
      await sessions.verify(tenants[0], a.session.sessionId, '999999', 1),
    ).toBeNull();
    expect(
      await sessions.verify(tenants[1], b.session.sessionId, '999999', 1),
    ).not.toBeNull();
    for (const tenantId of tenants)
      await ctx.run({ tenantId, userId: '999999' }, () => perms.permissions());
    const aKeys = await raw.keys(`jna-test:t:${tenants[0]}:perm:999999:*`),
      bKeys = await raw.keys(`jna-test:t:${tenants[1]}:perm:999999:*`);
    expect(aKeys.length).toBe(1);
    expect(bKeys.length).toBe(1);
    expect(aKeys[0]).not.toBe(bKeys[0]);
    await perms.bumpVersion(tenants[0]);
    expect(await perms.version(tenants[0])).toBe(1);
    expect(await perms.version(tenants[1])).toBe(0);
  });
});
