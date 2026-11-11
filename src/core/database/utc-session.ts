import type { DataSource } from 'typeorm';

interface MysqlConnection {
  query(sql: string, callback: (error: Error | null) => void): unknown;
}
const configured = new WeakSet<DataSource>();

/** timezone: Z 只负责驱动编解码；在每条物理连接首次使用前，等待 MySQL 会话切到 UTC。 */
export function applyUtcSessions(source: DataSource): void {
  if (configured.has(source)) return;
  configured.add(source);
  const pending = new WeakMap<object, Promise<void>>();
  const create = source.createQueryRunner.bind(source);
  source.createQueryRunner = (mode) => {
    const runner = create(mode);
    const connect = runner.connect.bind(runner);
    runner.connect = async () => {
      const connection = (await connect()) as MysqlConnection;
      let ready = pending.get(connection);
      if (!ready) {
        ready = new Promise<void>((resolve, reject) =>
          connection.query("SET SESSION time_zone = '+00:00'", (error) =>
            error ? reject(error) : resolve(),
          ),
        );
        pending.set(connection, ready);
        void ready.catch(() => pending.delete(connection));
      }
      // 初始化失败时不返回连接，业务查询不会在错误时区继续执行。
      await ready;
      return connection;
    };
    return runner;
  };
}
