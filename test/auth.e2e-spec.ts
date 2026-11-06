import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  AuthUserStore,
  type AuthOrg,
  type AuthProfile,
  type AuthUser,
} from '../src/core/auth/auth-user.store.js';
import { CaptchaProvider } from '../src/core/auth/captcha/captcha.provider.js';
import { PasswordHasher } from '../src/core/auth/password.js';
import { SessionService } from '../src/core/auth/session.service.js';
import { AppConfigService } from '../src/core/config/app-config.service.js';
import { RedisService } from '../src/core/redis/redis.service.js';
import { clearTestRedis, rawRedis } from './support/test-redis.js';

const ORIGIN = 'http://localhost:8848';
const PASSWORD = 'Passw0rd!';

interface FakeUser extends AuthUser {
  username: string;
  orgs: AuthOrg[];
}

const ORG_AU: AuthOrg = { id: '10', name: '澳洲站', path: ['集团', '澳洲站'] };
const ORG_SG: AuthOrg = {
  id: '20',
  name: '新加坡站',
  path: ['集团', '新加坡站'],
};
const users = new Map<string, FakeUser>();
/** 测试在登录途中插入动作（模拟 T07 这时改密、停用） */
const hooks: {
  afterFind?: () => Promise<void>;
  beforeListOrgs?: () => Promise<void>;
} = {};

/** 测试用用户来源：代替 system 模块（T07）。每次返回当时的快照，和读数据库一样 */
@Injectable()
class FakeUserStore extends AuthUserStore {
  async findForLogin(tenantId: string, username: string) {
    const u = tenantId === '1' ? users.get(username) : undefined;
    const snapshot = u ? { ...u } : null;
    const hook = hooks.afterFind;
    hooks.afterFind = undefined;
    if (hook) await hook();
    return snapshot;
  }
  async findProfile(
    tenantId: string,
    userId: string,
  ): Promise<AuthProfile | null> {
    const u = [...users.values()].find((x) => x.id === userId);
    if (!u || tenantId !== '1') return null;
    return {
      id: u.id,
      username: u.username,
      nickname: u.username,
      avatar: null,
      enabled: u.enabled,
    };
  }
  async listOrgs(_t: string, userId: string) {
    const hook = hooks.beforeListOrgs;
    hooks.beforeListOrgs = undefined;
    if (hook) await hook();
    return [...users.values()].find((x) => x.id === userId)?.orgs ?? [];
  }
}

const cookieOf = (res: request.Response): string | null => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = raw?.find((x) => x.startsWith('jna_rt='));
  if (!c) return null;
  const v = c.slice('jna_rt='.length, c.indexOf(';'));
  return v ? `jna_rt=${v}` : null;
};

const toPayload = async (challenge: Challenge) => {
  const solution = await solveChallenge({ challenge, deriveKey });
  if (!solution) throw new Error('解题失败');
  return Buffer.from(JSON.stringify({ challenge, solution })).toString(
    'base64',
  );
};

describe('后台登录认证（T05）', () => {
  let app: INestApplication<App>;
  let raw: Redis;
  let hash: string;

  const http = () => request(app.getHttpServer());
  const captcha = async (account: string) =>
    (
      await http()
        .get('/admin/auth/captcha')
        .query({ purpose: 'login', account })
        .expect(200)
    ).body as Challenge;
  const altchaFor = async (account: string) =>
    toPayload(await captcha(account));
  const login = (username: string, password: string, altcha?: string) =>
    http().post('/admin/auth/login').send({ username, password, altcha });
  /** 出题、解题、登录，返回访问令牌和刷新 Cookie */
  const signIn = async (username = 'admin') => {
    const res = await login(
      username,
      PASSWORD,
      await altchaFor(username),
    ).expect(200);
    return {
      token: res.body.data.accessToken as string,
      cookie: cookieOf(res)!,
      res,
    };
  };
  const refresh = (cookie: string | null, origin: string | null = ORIGIN) => {
    const r = http().post('/admin/auth/refresh');
    if (cookie) r.set('Cookie', cookie);
    if (origin) r.set('Origin', origin);
    return r;
  };
  const profile = (token: string) =>
    http()
      .get('/admin/session/profile')
      .set('Authorization', `Bearer ${token}`);
  const failCount = async (username: string) =>
    Number((await raw.get(`jna-test:t:1:auth:fail:acct:${username}`)) ?? 0);

  beforeAll(async () => {
    hash = await PasswordHasher.hash(PASSWORD);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthUserStore)
      .useClass(FakeUserStore)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    raw = rawRedis();
  });

  afterAll(async () => {
    await raw.quit();
    await app.close();
  });

  beforeEach(async () => {
    await clearTestRedis(raw);
    users.clear();
    hooks.afterFind = undefined;
    hooks.beforeListOrgs = undefined;
    users.set('admin', {
      id: '1',
      username: 'admin',
      passwordHash: hash,
      enabled: true,
      defaultOrgId: '20',
      orgs: [ORG_AU, ORG_SG],
    });
    users.set('frozen', {
      id: '2',
      username: 'frozen',
      passwordHash: hash,
      enabled: false,
      defaultOrgId: null,
      orgs: [],
    });
    users.set('loner', {
      id: '3',
      username: 'loner',
      passwordHash: hash,
      enabled: true,
      defaultOrgId: null,
      orgs: [],
    });
  });

  afterEach(() => vi.useRealTimers());

  describe('登录', () => {
    it('出题接口原样返回 ALTCHA 题目，不包统一结构，也不带难度级别', async () => {
      const ch = await captcha('admin');
      expect(ch).toHaveProperty('parameters');
      expect(ch).toHaveProperty('signature');
      expect(ch).not.toHaveProperty('code');
      expect(ch).not.toHaveProperty('level');
    });

    it('正常登录：返回访问令牌，刷新令牌在 HttpOnly Cookie 里；进入默认组织', async () => {
      const { res, token } = await signIn();
      expect(res.body).toMatchObject({
        code: 1000,
        data: { tokenType: 'Bearer', expiresIn: 1800 },
      });
      expect(JSON.stringify(res.body)).not.toContain('jna_rt');
      const set = (res.headers['set-cookie'] as unknown as string[]).join(';');
      expect(set).toMatch(/HttpOnly/);
      expect(set).toMatch(/Secure/);
      expect(set).toMatch(/SameSite=Strict/);
      expect(set).toMatch(/Path=\/admin\/auth/);
      const me = await profile(token).expect(200);
      expect(me.body.data).toEqual({
        user: { id: '1', username: 'admin', nickname: 'admin', avatar: null },
        currentOrg: ORG_SG,
        orgs: [ORG_AU, ORG_SG],
        locale: 'zh-CN',
      });
    });

    it('账号不区分大小写、忽略首尾空格；没有组织的用户当前组织为空', async () => {
      const res = await login(
        ' ADMIN ',
        PASSWORD,
        await altchaFor('Admin'),
      ).expect(200);
      expect(res.body.data.accessToken).toBeTruthy();
      const { token } = await signIn('loner');
      expect(
        (await profile(token).expect(200)).body.data.currentOrg,
      ).toBeNull();
    });

    it('账号不存在、密码错、已停用：一律 400「账号或密码错误」，都计失败次数', async () => {
      for (const [u, p] of [
        ['nobody', PASSWORD],
        ['admin', 'wrong-pass1'],
        ['frozen', PASSWORD],
      ]) {
        const res = await login(u, p, await altchaFor(u)).expect(400);
        expect(res.body).toEqual({
          code: 4000,
          data: null,
          message: '账号或密码错误',
        });
        expect(await failCount(u)).toBe(1);
      }
    });

    it('同一账号连续输错 5 次锁定：429 带 Retry-After，密码对了也不行；账号不存在照样锁', async () => {
      for (const u of ['admin', 'ghost']) {
        for (let i = 0; i < 5; i++)
          await login(u, 'wrong-pass1', await altchaFor(u)).expect(400);
        const res = await login(u, PASSWORD, await altchaFor(u)).expect(429);
        expect(res.body.code).toBe(4029);
        expect(res.body.data.retryAfterSeconds).toBeGreaterThan(800);
        expect(Number(res.headers['retry-after'])).toBe(
          res.body.data.retryAfterSeconds,
        );
      }
    });

    it('同一 IP 输错太多：换账号也被锁', async () => {
      await login('a1', 'wrong-pass1', await altchaFor('a1')).expect(400);
      const [ipKey] = await raw.keys('jna-test:t:1:auth:fail:ip:*');
      await raw.set(ipKey, 20, 'EX', 900);
      await login('admin', PASSWORD, await altchaFor('admin')).expect(429);
    });

    it('登录成功清掉这个账号的失败次数', async () => {
      await login('admin', 'wrong-pass1', await altchaFor('admin')).expect(400);
      await signIn();
      expect(await failCount('admin')).toBe(0);
    });
  });

  describe('人机验证：全部在核对密码之前拒绝，不计失败次数', () => {
    const rejected = async (res: request.Response) => {
      expect(res.status).toBe(400);
      expect(res.body.data).toEqual({
        errors: [{ field: 'altcha', messages: ['人机验证失败，请重试'] }],
      });
      // 用错误密码也是人机验证错误，说明没有走到密码校验
      expect(await failCount('admin')).toBe(0);
    };

    it('没带结果、乱填', async () => {
      await rejected(await login('admin', 'wrong-pass1'));
      await rejected(await login('admin', 'wrong-pass1', 'not-base64-json'));
    });

    it('重复提交同一结果', async () => {
      const a = await altchaFor('admin');
      await login('admin', PASSWORD, a).expect(200);
      await rejected(await login('admin', 'wrong-pass1', a));
    });

    it('并发提交同一结果：只有一次成功', async () => {
      const a = await altchaFor('admin');
      const all = await Promise.all(
        Array.from({ length: 6 }, () => login('admin', PASSWORD, a)),
      );
      expect(all.filter((r) => r.status === 200)).toHaveLength(1);
      expect(all.filter((r) => r.status === 400)).toHaveLength(5);
    });

    it('拿别的账号（或匿名）出的题登录', async () => {
      await rejected(
        await login('admin', 'wrong-pass1', await altchaFor('bob')),
      );
      await rejected(await login('admin', 'wrong-pass1', await altchaFor('')));
    });

    it('签名被篡改：改了绑定的账号', async () => {
      const ch = await captcha('bob');
      const payload = JSON.parse(
        Buffer.from(await toPayload(ch), 'base64').toString(),
      ) as { challenge: Challenge };
      (payload.challenge.parameters.data as Record<string, string>).subject =
        'admin';
      await rejected(
        await login(
          'admin',
          'wrong-pass1',
          Buffer.from(JSON.stringify(payload)).toString('base64'),
        ),
      );
    });

    it('登录题拿去别的用途、别的租户', async () => {
      const provider = app.get(CaptchaProvider);
      for (const binding of [
        { purpose: 'sms' as const, tenantId: '1', subject: 'admin' },
        { purpose: 'login' as const, tenantId: '2', subject: 'admin' },
      ]) {
        const ch = (await provider.create(binding, 2)) as Challenge;
        await rejected(
          await login('admin', 'wrong-pass1', await toPayload(ch)),
        );
      }
    });

    it('题目过期（2 分钟）', async () => {
      const a = await altchaFor('admin');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 125_000);
      await rejected(await login('admin', 'wrong-pass1', a));
    });

    it('难度升级前出的旧题作废，必须重新出题', async () => {
      const old = await altchaFor('admin');
      await login('admin', 'wrong-pass1', await altchaFor('admin')).expect(400);
      const res = await login('admin', PASSWORD, old).expect(400);
      expect(res.body.data.errors[0].field).toBe('altcha');
      expect(await failCount('admin')).toBe(1);
      await login('admin', PASSWORD, await altchaFor('admin')).expect(200);
    });
  });

  describe('访问令牌：每次请求核对会话', () => {
    it('没带、乱写、被篡改、过期：401 / 4001', async () => {
      const { token } = await signIn();
      await http().get('/admin/session/profile').expect(401);
      expect((await profile('abc.def.ghi').expect(401)).body.code).toBe(4001);
      const [h, p, s] = token.split('.');
      const forged = JSON.parse(Buffer.from(p, 'base64url').toString());
      forged.sub = '2';
      await profile(
        [h, Buffer.from(JSON.stringify(forged)).toString('base64url'), s].join(
          '.',
        ),
      ).expect(401);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 31 * 60_000);
      await profile(token).expect(401);
    });

    it('踢人（吊销用户全部会话）：旧访问令牌下一次请求立即被拒，刷新也失败', async () => {
      const a = await signIn();
      const b = await signIn();
      await app.get(SessionService).revokeUser('1', '1');
      await profile(a.token).expect(401);
      await profile(b.token).expect(401);
      await refresh(a.cookie).expect(401);
    });

    it('账号停用但漏了吊销会话：刷新时再核对一次，拒绝并吊销', async () => {
      const { token, cookie } = await signIn();
      users.get('admin')!.enabled = false;
      await refresh(cookie).expect(401);
      await profile(token).expect(401);
    });

    it('Redis 不可用：受保护接口一律 503，不放行；登录也 503', async () => {
      const { token } = await signIn();
      const client = app.get(RedisService).client;
      client.disconnect();
      try {
        expect((await profile(token).expect(503)).body.code).toBe(5003);
        await login('admin', PASSWORD, 'x').expect(503);
      } finally {
        await client.connect();
      }
      await profile(token).expect(200);
    });
  });

  describe('用户失效版本：吊销和建会话怎么交错都不漏', () => {
    const base = {
      tenantId: '1',
      userId: '1',
      orgId: null,
      ip: 'x',
      userAgent: 'ua',
    };
    const valid = (svc: SessionService, sid: string) =>
      svc.verify('1', sid, '1', 1).then((r) => r !== null);

    it('吊销后，用吊销前读到的版本建会话失败；之后新建的会话能被列出、能被再次吊销', async () => {
      const svc = app.get(SessionService);
      const epoch = await svc.userEpoch('1', '1');
      const a = (await svc.create({ ...base, expectedEpoch: epoch }))!;
      await svc.revokeUser('1', '1');
      expect(await valid(svc, a.session.sessionId)).toBe(false);
      expect(await svc.create({ ...base, expectedEpoch: epoch })).toBeNull();
      const b = (await svc.create({
        ...base,
        expectedEpoch: await svc.userEpoch('1', '1'),
      }))!;
      expect(await valid(svc, b.session.sessionId)).toBe(true);
      expect(
        (await svc.listUserSessions('1', '1')).map((x) => x.sessionId),
      ).toEqual([b.session.sessionId]);
      await svc.revokeUser('1', '1');
      expect(await valid(svc, b.session.sessionId)).toBe(false);
      expect(await svc.listUserSessions('1', '1')).toEqual([]);
    });

    it('吊销和建会话并发交错多轮：最后再吊销一次，没有任何会话还有效', async () => {
      const svc = app.get(SessionService);
      const sids: string[] = [];
      for (let i = 0; i < 30; i++) {
        const epoch = await svc.userEpoch('1', '1');
        const [, created] = await Promise.all([
          svc.revokeUser('1', '1'),
          svc.create({ ...base, expectedEpoch: epoch }),
          svc
            .create({ ...base, expectedEpoch: epoch })
            .then((c) => c && sids.push(c.session.sessionId)),
        ]);
        if (created) sids.push(created.session.sessionId);
      }
      const listed = (await svc.listUserSessions('1', '1')).map(
        (x) => x.sessionId,
      );
      for (const sid of sids)
        if (await valid(svc, sid)) expect(listed).toContain(sid);
      await svc.revokeUser('1', '1');
      for (const sid of sids) expect(await valid(svc, sid)).toBe(false);
    });

    it('单处登录：并发登录只有一个会话有效；再登录一次，之前的失效', async () => {
      const config = app.get(AppConfigService);
      const single = new SessionService(
        { auth: { ...config.auth, singleSession: true } } as AppConfigService,
        app.get(RedisService),
      );
      const epoch = await single.userEpoch('1', '1');
      const all = await Promise.all(
        Array.from({ length: 5 }, () =>
          single.create({ ...base, expectedEpoch: epoch }),
        ),
      );
      const ok = all.filter((x) => x !== null);
      expect(ok).toHaveLength(1);
      const first = ok[0]!.session.sessionId;
      expect(await valid(single, first)).toBe(true);
      const next = (await single.create({
        ...base,
        expectedEpoch: await single.userEpoch('1', '1'),
      }))!;
      expect(await valid(single, first)).toBe(false);
      expect(await valid(single, next.session.sessionId)).toBe(true);
      expect(
        (await single.listUserSessions('1', '1')).map((x) => x.sessionId),
      ).toEqual([next.session.sessionId]);
    });
  });

  describe('登录途中账号被停用或改密（T07 先提交数据库再 revokeUser）：这次登录建不成会话', () => {
    const noSession = async () =>
      expect(await app.get(SessionService).listUserSessions('1', '1')).toEqual(
        [],
      );
    const t07 = (change: (u: FakeUser) => void) => async () => {
      change(users.get('admin')!);
      await app.get(SessionService).revokeUser('1', '1');
    };

    it('核对密码时读到的还是旧数据，之后被停用', async () => {
      hooks.afterFind = t07((u) => (u.enabled = false));
      await login('admin', PASSWORD, await altchaFor('admin')).expect(400);
      await noSession();
    });

    it('核对密码时读到的还是旧密码，之后改了密码', async () => {
      const newHash = await PasswordHasher.hash('N3w-passw0rd');
      hooks.afterFind = t07((u) => (u.passwordHash = newHash));
      await login('admin', PASSWORD, await altchaFor('admin')).expect(400);
      await noSession();
    });

    it('账号复核之后、建会话之前被停用', async () => {
      hooks.beforeListOrgs = t07((u) => (u.enabled = false));
      const res = await login(
        'admin',
        PASSWORD,
        await altchaFor('admin'),
      ).expect(400);
      expect(res.body.message).toBe('登录失败，请重试');
      await noSession();
    });
  });

  describe('刷新令牌轮换', () => {
    it('刷新：换新的访问令牌和刷新令牌', async () => {
      const { cookie } = await signIn();
      const res = await refresh(cookie).expect(200);
      expect(res.body.data.tokenType).toBe('Bearer');
      const next = cookieOf(res);
      expect(next).toBeTruthy();
      expect(next).not.toBe(cookie);
      await profile(res.body.data.accessToken).expect(200);
      await refresh(next).expect(200);
    });

    it('没有 Cookie、乱写：401 并清 Cookie', async () => {
      const res = await refresh(null).expect(401);
      expect((res.headers['set-cookie'] as unknown as string[]).join()).toMatch(
        /jna_rt=;/,
      );
      await refresh('jna_rt=not-a-real-token-at-all-xxxx').expect(401);
    });

    it('来源不是后台地址：403', async () => {
      const { cookie } = await signIn();
      await refresh(cookie, null).expect(403);
      await refresh(cookie, 'https://evil.example.com').expect(403);
      await refresh(cookie).expect(200);
    });

    it('并发用同一个刷新令牌：只成功一个', async () => {
      const { cookie } = await signIn();
      const all = await Promise.all(
        Array.from({ length: 5 }, () => refresh(cookie)),
      );
      expect(all.filter((r) => r.status === 200)).toHaveLength(1);
    });

    it('旧刷新令牌被再次使用：吊销这个会话的整个令牌族，其他设备不受影响', async () => {
      const phone = await signIn();
      const pc = await signIn();
      const r1 = await refresh(pc.cookie).expect(200);
      await refresh(pc.cookie).expect(401);
      // 这台设备刷新出来的新令牌也一起作废
      await profile(r1.body.data.accessToken).expect(401);
      await refresh(cookieOf(r1)).expect(401);
      await profile(pc.token).expect(401);
      // 另一台设备不受影响
      await profile(phone.token).expect(200);
      await refresh(phone.cookie).expect(200);
    });
  });

  describe('退出', () => {
    it('退出后访问令牌和刷新令牌都失效；会话本来就没了也返回 200', async () => {
      const { token, cookie } = await signIn();
      await http()
        .post('/admin/auth/logout')
        .set('Origin', ORIGIN)
        .set('Cookie', cookie)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await profile(token).expect(401);
      await refresh(cookie).expect(401);
      await http().post('/admin/auth/logout').set('Origin', ORIGIN).expect(200);
    });

    it('只带 Cookie 也能退出', async () => {
      const { token, cookie } = await signIn();
      await http()
        .post('/admin/auth/logout')
        .set('Origin', ORIGIN)
        .set('Cookie', cookie)
        .expect(200);
      await profile(token).expect(401);
    });
  });

  describe('切换组织', () => {
    const switchOrg = (token: string, orgId: string, origin = ORIGIN) =>
      http()
        .post('/admin/session/switch-org')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', origin)
        .send({ orgId });

    it('换成新组织的令牌，旧访问令牌立即失效，刷新令牌一起换', async () => {
      const { token, cookie } = await signIn();
      const res = await switchOrg(token, '10').expect(200);
      const next = res.body.data.accessToken as string;
      expect((await profile(next).expect(200)).body.data.currentOrg).toEqual(
        ORG_AU,
      );
      await profile(token).expect(401);
      const newCookie = cookieOf(res);
      expect(newCookie).not.toBe(cookie);
      const r = await refresh(newCookie).expect(200);
      expect(
        (await profile(r.body.data.accessToken).expect(200)).body.data
          .currentOrg,
      ).toEqual(ORG_AU);
    });

    it('在这个组织没有角色：403，令牌不变', async () => {
      const { token } = await signIn();
      await switchOrg(token, '99').expect(403);
      await profile(token).expect(200);
    });

    it('来源不是后台地址：403', async () => {
      const { token } = await signIn();
      await switchOrg(token, '10', 'https://evil.example.com').expect(403);
    });
  });
});
