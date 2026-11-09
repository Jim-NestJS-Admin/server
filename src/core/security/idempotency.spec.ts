import { StreamableFile, type CallHandler } from '@nestjs/common';
import type { Request } from 'express';
import { ClsServiceManager } from 'nestjs-cls';
import { of } from 'rxjs';
import type { DataSource, EntityManager } from 'typeorm';
import type { RedisService } from '../redis/redis.service.js';
import type { RequestContext } from '../tenant/request-context.js';
import {
  IdempotencyRunner,
  isBinaryResult,
} from './idempotency.interceptor.js';
import { IdempotencyLedger } from './idempotency.ledger.js';

const cls = ClsServiceManager.getClsService();
const claim = {
  tenantId: '1',
  userId: '7',
  key: 'key-00000001',
  owner: '[]',
  digest: 'd',
};

/** 假数据源：transaction 先跑事务体，按 mode 决定提交成功还是提交时出错 */
const fakeDs = (mode: 'ok' | 'commitFails') => {
  const repo = {
    delete: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    findOne: vi.fn(async () => null),
  };
  const manager = { getRepository: () => repo } as unknown as EntityManager;
  const ds = {
    transaction: async (fn: (m: EntityManager) => Promise<unknown>) => {
      const r = await fn(manager);
      if (mode === 'commitFails') throw new Error('提交时连接断开');
      return r;
    },
    getRepository: () => repo,
  } as unknown as DataSource;
  return { ds, repo };
};

describe('幂等账本的提交状态', () => {
  it('事务提交后才算 committed', async () => {
    const { ds } = fakeDs('ok');
    const ledger = new IdempotencyLedger(cls, ds);
    await cls.run(async () => {
      ledger.begin(claim);
      await ledger.transaction(async () => 'x');
      expect(ledger.pending()?.state).toBe('committed');
    });
  });

  it('事务体出错（已回滚）：状态退回 none，后面的事务还能写记录', async () => {
    const { ds } = fakeDs('ok');
    const ledger = new IdempotencyLedger(cls, ds);
    await cls.run(async () => {
      ledger.begin(claim);
      // 事务体先写了记录、随后才失败
      await expect(
        ledger.transaction(async (m) => {
          await ledger.recordInTx(m, 'partial');
          throw new Error('业务校验失败');
        }),
      ).rejects.toThrow('业务校验失败');
      expect(ledger.pending()?.state).toBe('none');
    });
  });

  it('事务体完成、提交时出错：状态是 unknown，不当成功也不当失败', async () => {
    const { ds } = fakeDs('commitFails');
    const ledger = new IdempotencyLedger(cls, ds);
    await cls.run(async () => {
      ledger.begin(claim);
      await expect(ledger.transaction(async () => 'x')).rejects.toThrow();
      expect(ledger.pending()?.state).toBe('unknown');
    });
  });
});

describe('幂等执行', () => {
  const redisStore = new Map<string, string>();
  const redis = {
    tenantKey: (...p: string[]) => p.join(':'),
    call: async (fn: (r: unknown) => unknown) =>
      fn({
        set: (k: string, v: string, ...a: unknown[]) => {
          if (a.includes('NX') && redisStore.has(k)) return null;
          redisStore.set(k, v);
          return 'OK';
        },
        get: (k: string) => redisStore.get(k) ?? null,
        del: (k: string) => redisStore.delete(k),
      }),
  } as unknown as RedisService;
  const context = {
    current: () => ({ tenantId: '1', orgId: '3', userId: '7' }),
  } as unknown as RequestContext;
  const next = (v: unknown): CallHandler => ({ handle: () => of(v) });

  beforeEach(() => redisStore.clear());

  it('二进制结果不保存、不缓存，原样返回，占位释放', async () => {
    const { ds, repo } = fakeDs('ok');
    const ledger = new IdempotencyLedger(cls, ds);
    const runner = new IdempotencyRunner(redis, context, ledger);
    const file = new StreamableFile(Buffer.from('a,b'));
    await cls.run(async () => {
      const out = await runner.run('key-00000001', 'x:export', 'd', next(file));
      expect(out).toBe(file);
    });
    expect(repo.insert).not.toHaveBeenCalled();
    expect(redisStore.size).toBe(0);
    expect(isBinaryResult(Buffer.from('x'))).toBe(true);
    expect(isBinaryResult({ id: '1' })).toBe(false);
  });

  it('处理失败只释放占位，不把任何结果缓存成成功', async () => {
    const { ds } = fakeDs('ok');
    const ledger = new IdempotencyLedger(cls, ds);
    const runner = new IdempotencyRunner(redis, context, ledger);
    const failing: CallHandler = {
      handle: () => {
        throw new Error('业务失败');
      },
    };
    await cls.run(async () => {
      await expect(
        runner.run('key-00000001', 'x:add', 'd', failing),
      ).rejects.toThrow();
    });
    expect(redisStore.size).toBe(0);
  });

  it('上传摘要包含文件内容：同一请求体换了文件，摘要不同', () => {
    const runner = new IdempotencyRunner(redis, context, {} as never);
    const req = (content: string) =>
      ({
        method: 'POST',
        path: '/admin/file/asset/upload',
        body: {},
        file: {
          fieldname: 'file',
          size: content.length,
          buffer: Buffer.from(content),
        },
      }) as unknown as Request;
    expect(runner.digest(req('A'), true)).not.toBe(
      runner.digest(req('B'), true),
    );
    // 不算文件时两者相同：说明区别确实来自文件内容
    expect(runner.digest(req('A'), false)).toBe(runner.digest(req('B'), false));
  });
});
