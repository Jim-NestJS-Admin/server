import type { DataSource } from 'typeorm';
import { applyUtcSessions } from './utc-session.js';

describe('MySQL UTC 会话', () => {
  it('同一物理连接并发使用也只初始化一次，业务等待初始化结束', async () => {
    let finish!: (error: Error | null) => void;
    const connection = {
      query: vi.fn((_sql: string, callback: typeof finish) => {
        finish = callback;
      }),
    };
    const source = {
      createQueryRunner: () => ({ connect: async () => connection }),
    } as unknown as DataSource;
    applyUtcSessions(source);
    applyUtcSessions(source);
    let done = false;
    const first = source
      .createQueryRunner()
      .connect()
      .then(() => {
        done = true;
      });
    const second = source.createQueryRunner().connect();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(done).toBe(false);
    expect(connection.query).toHaveBeenCalledExactlyOnceWith(
      "SET SESSION time_zone = '+00:00'",
      expect.any(Function),
    );
    finish(null);
    await Promise.all([first, second]);
    await source.createQueryRunner().connect();
    expect(connection.query).toHaveBeenCalledTimes(1);
  });
  it('初始化失败拒绝业务查询，重试会重新设时区；新连接单独初始化', async () => {
    let fail = true;
    const connection = {
      query: vi.fn((_sql: string, callback: (error: Error | null) => void) =>
        callback(fail ? new Error('拒绝设置') : null),
      ),
    };
    const source = {
      createQueryRunner: () => ({ connect: async () => connection }),
    } as unknown as DataSource;
    applyUtcSessions(source);
    await expect(source.createQueryRunner().connect()).rejects.toThrow(
      '拒绝设置',
    );
    fail = false;
    await source.createQueryRunner().connect();
    expect(connection.query).toHaveBeenCalledTimes(2);
  });
});
