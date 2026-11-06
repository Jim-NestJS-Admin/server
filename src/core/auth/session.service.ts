import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { RedisService } from '../redis/redis.service.js';

export interface SessionInfo {
  sessionId: string;
  userId: string;
  orgId: string | null;
  version: number;
}

export interface OnlineSession {
  sessionId: string;
  orgId: string | null;
  ip: string;
  userAgent: string;
  createdAt: number;
}

export type RotateResult =
  | { status: 'ok'; session: SessionInfo; refreshToken: string }
  | { status: 'invalid' }
  /** 已经用过的刷新令牌又来了：这个会话已被整体吊销 */
  | { status: 'reuse'; userId: string; sessionId: string };

/**
 * 刷新令牌轮换（原子）。KEYS：旧令牌、会话、新令牌、用户的会话集合、用户的失效版本；
 * ARGV：旧令牌摘要、新令牌摘要、新令牌存活秒数、会话编号、是否把会话版本加 1、新的当前组织（空串不改）。
 * - 旧令牌不存在、不属于这个会话、会话当前令牌不是它、或会话建立后用户被整体吊销过：invalid；
 * - 旧令牌已经用过：说明被重复使用，删掉会话（整个令牌族作废）：reuse；
 * - 否则标记旧令牌已用、登记新令牌、会话指向新令牌：ok。
 */
const ROTATE = `
local rt = redis.call('HMGET', KEYS[1], 'sid', 'used')
local epoch = redis.call('GET', KEYS[5]) or '0'
if not rt[1] or rt[1] ~= ARGV[4] then return {'invalid'} end
if rt[2] == '1' then
  local uid = redis.call('HGET', KEYS[2], 'uid')
  if not uid then return {'invalid'} end
  redis.call('DEL', KEYS[2])
  redis.call('SREM', KEYS[4], ARGV[4])
  return {'reuse', uid}
end
local cur = redis.call('HMGET', KEYS[2], 'rt', 'uid', 'org', 'sv', 'gen')
if not cur[1] or cur[1] ~= ARGV[1] then return {'invalid'} end
if cur[5] ~= epoch then return {'invalid'} end
redis.call('HSET', KEYS[1], 'used', '1')
redis.call('HSET', KEYS[3], 'sid', ARGV[4], 'used', '0')
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[3]))
redis.call('HSET', KEYS[2], 'rt', ARGV[2])
local sv = tonumber(cur[4])
if ARGV[5] == '1' then sv = redis.call('HINCRBY', KEYS[2], 'sv', 1) end
local org = cur[3]
if ARGV[6] ~= '' then
  redis.call('HSET', KEYS[2], 'org', ARGV[6])
  org = ARGV[6]
end
return {'ok', cur[2], org, tostring(sv)}
`;

/**
 * 建会话（原子）。KEYS：用户的失效版本、会话、刷新令牌、用户的会话集合；
 * ARGV：登录时读到的失效版本、是否单处登录、会话 / 令牌 / 集合存活秒数，然后是会话字段。
 * 失效版本已经变了（这期间有人改密、停用、踢人或另一处单处登录抢先）：stale，不建会话。
 * 单处登录时先把版本加 1，之前的会话全部失效，再用新版本建会话。
 */
const CREATE = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur ~= tonumber(ARGV[1]) then return {'stale'} end
if ARGV[2] == '1' then cur = redis.call('INCR', KEYS[1]) end
redis.call('HSET', KEYS[2], 'uid', ARGV[6], 'org', ARGV[7], 'sv', '1', 'rt', ARGV[8],
  'abs', ARGV[9], 'ip', ARGV[10], 'ua', ARGV[11], 'created', ARGV[12], 'gen', tostring(cur))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
redis.call('HSET', KEYS[3], 'sid', ARGV[13], 'used', '0')
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[4]))
redis.call('SADD', KEYS[4], ARGV[13])
redis.call('EXPIRE', KEYS[4], tonumber(ARGV[5]))
return {'ok', tostring(cur)}
`;

/** 会话里没有当前组织时存的值（Redis 哈希不能存 null） */
const NO_ORG = '-';
const orgOut = (v: string | null | undefined) =>
  !v || v === NO_ORG ? null : v;

const digest = (token: string) =>
  createHash('sha256').update(token).digest('base64url');

/**
 * 后台会话（架构「安全基线 · 账号与会话」）：
 * - 一次登录一个会话，会话下的刷新令牌每次刷新都换新的，旧的标记「已用」并留到会话到期，用来识别重复使用；
 * - 访问令牌带会话编号和会话版本，每次请求核对会话还在、版本没变；
 * - 每个用户有一个「失效版本」，吊销用户全部会话就把它加 1（一条原子命令）；会话记录建立时的版本，
 *   每次请求、刷新、建会话都核对，版本不一致一律无效。所以和建会话怎么交错都不会漏掉，
 *   登录途中被改密、停用、踢人，这次登录也建不成会话（见 AuthService.login 的顺序）。
 * Redis 里只存刷新令牌的摘要，不存原文。
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
  ) {}

  private sessKey(tenantId: string, sessionId: string) {
    return this.redis.tenantKey(tenantId, 'auth', 'sess', sessionId);
  }
  private userKey(tenantId: string, userId: string) {
    return this.redis.tenantKey(tenantId, 'auth', 'user', userId, 'sess');
  }
  private epochKey(tenantId: string, userId: string) {
    return this.redis.tenantKey(tenantId, 'auth', 'user', userId, 'gen');
  }
  private rtKey(tenantId: string, hash: string) {
    return this.redis.tenantKey(tenantId, 'auth', 'rt', hash);
  }

  private now() {
    return Math.floor(Date.now() / 1000);
  }

  /** 会话 key 的存活时间：不超过绝对有效期，启用了空闲退出时也不超过空闲时长 */
  private sessionTtl(absoluteExpiresAt: number) {
    const left = Math.max(1, absoluteExpiresAt - this.now());
    const idle = this.config.auth.idleSeconds;
    return idle > 0 ? Math.min(idle, left) : left;
  }

  /** 用户当前的失效版本。登录时在核对账号之前读，建会话时原样传回 */
  async userEpoch(tenantId: string, userId: string): Promise<number> {
    const v = await this.redis.call((r) =>
      r.get(this.epochKey(tenantId, userId)),
    );
    return Number(v ?? 0);
  }

  /** 建会话；失效版本和 expectedEpoch 不一致时返回 null（这期间账号被改密、停用、踢人） */
  async create(input: {
    tenantId: string;
    userId: string;
    orgId: string | null;
    ip: string;
    userAgent: string;
    expectedEpoch: number;
  }): Promise<{ session: SessionInfo; refreshToken: string } | null> {
    const { tenantId, userId } = input;
    const single = this.config.auth.singleSession;
    const sessionId = randomUUID();
    const refreshToken = randomBytes(32).toString('base64url');
    const hash = digest(refreshToken);
    const ttl = this.config.auth.refreshTtlSeconds;
    const abs = this.now() + ttl;
    const res = (await this.redis.call((r) =>
      r.eval(
        CREATE,
        4,
        this.epochKey(tenantId, userId),
        this.sessKey(tenantId, sessionId),
        this.rtKey(tenantId, hash),
        this.userKey(tenantId, userId),
        input.expectedEpoch,
        single ? '1' : '0',
        this.sessionTtl(abs),
        ttl,
        ttl,
        userId,
        input.orgId ?? NO_ORG,
        hash,
        abs,
        input.ip,
        input.userAgent.slice(0, 300),
        this.now(),
        sessionId,
      ),
    )) as string[];
    if (res[0] !== 'ok') return null;
    if (single) await this.cleanup(tenantId, userId, Number(res[1]));
    return {
      session: { sessionId, userId, orgId: input.orgId, version: 1 },
      refreshToken,
    };
  }

  /** 每次请求核对：会话还在、属于这个用户、版本没变；启用空闲退出时顺便续期 */
  async verify(
    tenantId: string,
    sessionId: string,
    userId: string,
    version: number,
  ): Promise<SessionInfo | null> {
    const sk = this.sessKey(tenantId, sessionId);
    // 同一个 MULTI 里读会话和用户的失效版本，拿到的是同一时刻的值
    const res = await this.redis.call((r) =>
      r
        .multi()
        .hmget(sk, 'uid', 'org', 'sv', 'abs', 'gen')
        .get(this.epochKey(tenantId, userId))
        .exec(),
    );
    if (!res || res.some(([err]) => err)) throw new Error('Redis 事务失败');
    const [uid, org, sv, abs, gen] = res[0][1] as (string | null)[];
    const epoch = (res[1][1] as string | null) ?? '0';
    if (!uid || uid !== userId || Number(sv) !== version || gen !== epoch)
      return null;
    if (this.config.auth.idleSeconds > 0)
      await this.redis.call((r) => r.expire(sk, this.sessionTtl(Number(abs))));
    return { sessionId, userId, orgId: orgOut(org), version };
  }

  /** 用刷新令牌换新的（刷新接口） */
  async rotate(tenantId: string, refreshToken: string): Promise<RotateResult> {
    const rk = this.rtKey(tenantId, digest(refreshToken));
    const sid = await this.redis.call((r) => r.hget(rk, 'sid'));
    if (!sid) return { status: 'invalid' };
    return this.runRotate(tenantId, sid, rk, { bumpVersion: false });
  }

  /** 切换当前组织：会话改组织、版本加 1（旧访问令牌立即失效），同时换刷新令牌 */
  async switchOrg(
    tenantId: string,
    sessionId: string,
    orgId: string,
  ): Promise<RotateResult> {
    const cur = await this.redis.call((r) =>
      r.hget(this.sessKey(tenantId, sessionId), 'rt'),
    );
    if (!cur) return { status: 'invalid' };
    return this.runRotate(tenantId, sessionId, this.rtKey(tenantId, cur), {
      bumpVersion: true,
      orgId,
    });
  }

  private async runRotate(
    tenantId: string,
    sessionId: string,
    oldRtKey: string,
    opts: { bumpVersion: boolean; orgId?: string },
  ): Promise<RotateResult> {
    const sk = this.sessKey(tenantId, sessionId);
    const [uid, abs] = await this.redis.call((r) => r.hmget(sk, 'uid', 'abs'));
    if (!uid) return { status: 'invalid' };
    const refreshToken = randomBytes(32).toString('base64url');
    const newHash = digest(refreshToken);
    const ttl = Math.max(1, Number(abs) - this.now());
    const oldHash = oldRtKey.slice(oldRtKey.lastIndexOf(':') + 1);
    const res = (await this.redis.call((r) =>
      r.eval(
        ROTATE,
        5,
        oldRtKey,
        sk,
        this.rtKey(tenantId, newHash),
        this.userKey(tenantId, uid),
        this.epochKey(tenantId, uid),
        oldHash,
        newHash,
        ttl,
        sessionId,
        opts.bumpVersion ? '1' : '0',
        opts.orgId ?? '',
      ),
    )) as string[];
    if (res[0] === 'reuse')
      return { status: 'reuse', userId: res[1], sessionId };
    if (res[0] !== 'ok') return { status: 'invalid' };
    if (this.config.auth.idleSeconds > 0)
      await this.redis.call((r) => r.expire(sk, this.sessionTtl(Number(abs))));
    return {
      status: 'ok',
      refreshToken,
      session: {
        sessionId,
        userId: res[1],
        orgId: orgOut(res[2]),
        version: Number(res[3]),
      },
    };
  }

  /** 刷新令牌属于哪个会话（退出时用）；令牌不存在返回 null */
  async sessionOfRefreshToken(
    tenantId: string,
    refreshToken: string,
  ): Promise<string | null> {
    return this.redis.call((r) =>
      r.hget(this.rtKey(tenantId, digest(refreshToken)), 'sid'),
    );
  }

  /** 吊销一个会话（退出、踢掉某台设备）。返回会话所属用户，会话本来就不在时返回 null */
  async revoke(tenantId: string, sessionId: string): Promise<string | null> {
    const sk = this.sessKey(tenantId, sessionId);
    const uid = await this.redis.call((r) => r.hget(sk, 'uid'));
    if (!uid) return null;
    await this.redis.call((r) =>
      r.multi().del(sk).srem(this.userKey(tenantId, uid), sessionId).exec(),
    );
    return uid;
  }

  /**
   * 吊销用户的全部会话：改密码、重置密码、停用、删除账号、管理员「下线该用户的全部会话」时调用。
   * 失效版本加 1 是一条原子命令，之后这个用户的所有旧会话（包括正在建立的）一律无效；
   * 调用方要在数据库改动**提交之后**再调用（登录流程靠这个顺序挡住在途的旧密码登录）。
   * 返回清理掉的会话数。
   */
  async revokeUser(tenantId: string, userId: string): Promise<number> {
    const epoch = await this.redis.call((r) =>
      r.incr(this.epochKey(tenantId, userId)),
    );
    return this.cleanup(tenantId, userId, epoch);
  }

  /**
   * 清理版本低于 epoch 的会话（它们已经无效，清理只是省空间、让在线列表干净）。
   * 只删逐个核对过版本的会话和对应的索引项，不整体删索引，并发新建的会话不会丢。
   */
  private async cleanup(
    tenantId: string,
    userId: string,
    epoch: number,
  ): Promise<number> {
    const uk = this.userKey(tenantId, userId);
    const sids = await this.redis.call((r) => r.smembers(uk));
    let removed = 0;
    for (const sid of sids) {
      const sk = this.sessKey(tenantId, sid);
      const gen = await this.redis.call((r) => r.hget(sk, 'gen'));
      if (gen !== null && Number(gen) >= epoch) continue;
      await this.redis.call((r) => r.multi().del(sk).srem(uk, sid).exec());
      removed++;
    }
    return removed;
  }

  /** 用户的在线会话（管理员查看、强制下线用）；顺便清掉已经过期的编号 */
  async listUserSessions(
    tenantId: string,
    userId: string,
  ): Promise<OnlineSession[]> {
    const uk = this.userKey(tenantId, userId);
    const epoch = String(await this.userEpoch(tenantId, userId));
    const sids = await this.redis.call((r) => r.smembers(uk));
    const out: OnlineSession[] = [];
    const stale: string[] = [];
    for (const sid of sids) {
      const h = await this.redis.call((r) =>
        r.hgetall(this.sessKey(tenantId, sid)),
      );
      if (!h.uid || h.gen !== epoch) {
        stale.push(sid);
        continue;
      }
      out.push({
        sessionId: sid,
        orgId: orgOut(h.org),
        ip: h.ip ?? '',
        userAgent: h.ua ?? '',
        createdAt: Number(h.created),
      });
    }
    // 只从索引里摘掉；失效会话的数据等 revokeUser 的清理或自然过期
    if (stale.length) await this.redis.call((r) => r.srem(uk, ...stale));
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
}
