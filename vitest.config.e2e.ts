import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { resolveTestDatabase } from './test/support/test-database.js';

// 端到端测试连真实 MySQL 的测试库（<DB_NAME>_test，compose 首次启动时建好）。
// 账号、密码、端口和开发一样从 .env 读；这里只把库名换成测试库，并允许测试环境自动建表。
const fileEnv = loadEnv('test', process.cwd(), '');
// 不是独立测试库（不以 _test 结尾、或和应用库同名）就在这里直接失败，不会连库、建表或删数据
const testDb = resolveTestDatabase({
  appDb: process.env.DB_NAME ?? fileEnv.DB_NAME,
  testDb: process.env.DB_TEST_NAME ?? fileEnv.DB_TEST_NAME,
});

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DB_NAME: testDb,
      DB_SYNCHRONIZE: 'true',
    },
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // 各测试文件共用一个测试库，串行执行，避免自动建表互相打架
    fileParallelism: false,
  },
});
