import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    root: './',
    include: ['**/*.e2e-spec.ts'],
  },
});
