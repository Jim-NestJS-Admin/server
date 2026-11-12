import { assertTestDatabase, resolveTestDatabase } from './test-database.js';

describe('端到端测试库保护 resolveTestDatabase', () => {
  it('默认用应用库名加 _test', () => {
    expect(resolveTestDatabase({ appDb: 'jim_admin', testDb: undefined })).toBe(
      'jim_admin_test',
    );
    expect(resolveTestDatabase({ appDb: undefined, testDb: undefined })).toBe(
      'jim_admin_test',
    );
    expect(resolveTestDatabase({ appDb: 'app', testDb: 'ci_app_test' })).toBe(
      'ci_app_test',
    );
  });

  it.each([
    ['和应用库同名', 'app_test', 'app_test', /同名/],
    ['只是大小写不同', 'App_Test', 'app_test', /同名/],
    ['不以 _test 结尾', 'app', 'app', /_test 结尾/],
    ['指向别的普通库', 'app', 'production', /_test 结尾/],
    ['库名带特殊字符', 'app', 'x`; DROP DATABASE app; --_test', /_test 结尾/],
  ])('%s：拒绝', (_name, appDb, testDb, error) => {
    expect(() => resolveTestDatabase({ appDb, testDb })).toThrow(error);
  });
});

describe('清理前实际连接库保护 assertTestDatabase', () => {
  it.each(['jim_admin_test', 'jim_admin_integration_20261109_test'])(
    '允许配置与实际连接一致的独立测试库 %s',
    (database) => {
      expect(() => assertTestDatabase(database, database)).not.toThrow();
    },
  );

  it.each([
    ['jim_admin_local', 'jim_admin_test'],
    ['another_test', 'jim_admin_test'],
    ['jim_admin_local', 'jim_admin_local'],
    ['jim_admin_test', undefined],
    [undefined, 'jim_admin_test'],
    ['jim_admin_test', ''],
  ])('拒绝未配置、非测试库或连接不一致 %s / %s', (actual, configured) => {
    expect(() => assertTestDatabase(actual, configured)).toThrow();
  });
});
