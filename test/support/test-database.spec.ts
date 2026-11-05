import { resolveTestDatabase } from './test-database.js';

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
