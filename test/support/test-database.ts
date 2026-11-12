/**
 * 端到端测试会自动建表、清空数据，所以连接前先确认目标库是独立的测试库：
 * - 库名必须以 _test 结尾（只允许字母、数字、下划线）；
 * - 不能和应用本身配置的库同名。
 * 不满足就在加载测试配置时直接失败，这时还没有建立任何数据库连接。
 */
export function resolveTestDatabase(input: {
  appDb: string | undefined;
  testDb: string | undefined;
}): string {
  const appDb = input.appDb?.trim() || 'jim_admin';
  const testDb = input.testDb?.trim() || `${appDb}_test`;
  if (!/^[A-Za-z0-9_]+_test$/.test(testDb))
    throw new Error(
      `端到端测试库名必须以 _test 结尾（只能有字母、数字、下划线），现在是「${testDb}」。测试会清空这个库，已拒绝启动。`,
    );
  if (testDb.toLowerCase() === appDb.toLowerCase())
    throw new Error(
      `端到端测试库「${testDb}」和应用库同名。测试会清空这个库，已拒绝启动。`,
    );
  return testDb;
}

/** 清理数据前再次确认实际连接没有偏离端到端测试配置。 */
export function assertTestDatabase(
  actualDatabase: unknown,
  configuredDatabase: string | undefined,
): void {
  if (!configuredDatabase) throw new Error('未设置端到端测试库，拒绝清理数据');
  const expected = resolveTestDatabase({
    appDb: undefined,
    testDb: configuredDatabase,
  });
  if (actualDatabase !== expected)
    throw new Error('实际连接库与端到端测试配置不一致，拒绝清理数据');
}
