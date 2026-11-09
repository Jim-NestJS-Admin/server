import type { DataSource } from 'typeorm';

interface PooledConnection {
  query(sql: string, values: unknown[], cb: (err: unknown) => void): unknown;
  jnaTimeoutSet?: number;
}
interface Pool {
  on(event: 'acquire', fn: (conn: PooledConnection) => void): void;
}

/**
 * 查询超时（架构「安全基线 · 防拖垮服务器」）：每个数据库连接第一次被取用时设置会话级 max_execution_time，
 * 只读查询（列表、导出、高级查询）超过时长由 MySQL 直接中止，不会长时间占住连接。写语句不受影响。
 * mysql2 同一连接上的命令按顺序执行，SET 一定排在本次业务查询前面；每个连接只设一次。
 */
export function applyQueryTimeout(dataSource: DataSource, ms: number): void {
  if (ms <= 0) return;
  const pool = (dataSource.driver as unknown as { pool?: Pool }).pool;
  if (!pool) return; // 导出接口文档时不连库
  pool.on('acquire', (conn) => {
    if (conn.jnaTimeoutSet === ms) return;
    conn.jnaTimeoutSet = ms;
    conn.query('SET SESSION max_execution_time = ?', [ms], (err) => {
      // 设置失败不影响业务查询，只是没有超时保护；下次取用时再试
      if (err) conn.jnaTimeoutSet = undefined;
    });
  });
}
