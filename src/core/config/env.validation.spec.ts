import { NodeEnv, validateEnv as validateRaw } from './env.validation.js';

/** 数据库连接信息是必填项；其他用例只关心各自的配置，统一补上 */
const DB = { DB_NAME: 'app', DB_USER: 'app', DB_PASSWORD: 'secret' };
const validateEnv = (raw: Record<string, unknown>) =>
  validateRaw({ ...DB, ...raw });

describe('validateEnv', () => {
  it('不传时使用默认值，开发环境默认开启接口文档', () => {
    const env = validateEnv({});
    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(3000);
    expect(env.SWAGGER_ENABLED).toBe(true);
  });

  it('生产环境默认关闭接口文档，显式开启才开', () => {
    expect(validateEnv({ NODE_ENV: 'production' }).SWAGGER_ENABLED).toBe(false);
    expect(
      validateEnv({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' })
        .SWAGGER_ENABLED,
    ).toBe(true);
  });

  it('接口文档开关只认 true / false，拼错时启动失败（不会被静默当成 false）', () => {
    expect(validateEnv({ SWAGGER_ENABLED: 'TRUE' }).SWAGGER_ENABLED).toBe(true);
    expect(validateEnv({ SWAGGER_ENABLED: ' false ' }).SWAGGER_ENABLED).toBe(
      false,
    );
    expect(() => validateEnv({ SWAGGER_ENABLED: 'flase' })).toThrow(
      /SWAGGER_ENABLED/,
    );
    expect(() => validateEnv({ SWAGGER_ENABLED: 'yes' })).toThrow(
      /SWAGGER_ENABLED/,
    );
  });

  it('端口不是数字时启动失败', () => {
    expect(() => validateEnv({ PORT: 'abc' })).toThrow(
      /环境变量校验失败[\s\S]*PORT/,
    );
  });

  it('非法的运行环境和日志级别启动失败', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => validateEnv({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('数据库：默认本机 3306，库名、账号、密码缺一个都启动失败', () => {
    const env = validateEnv({});
    expect(env.DB_HOST).toBe('127.0.0.1');
    expect(env.DB_PORT).toBe(3306);
    for (const key of ['DB_NAME', 'DB_USER', 'DB_PASSWORD'])
      expect(() => validateEnv({ [key]: '' })).toThrow(new RegExp(key));
    expect(() => validateRaw({})).toThrow(
      /DB_NAME[\s\S]*DB_USER[\s\S]*DB_PASSWORD/,
    );
  });

  it('自动建表只允许测试环境打开', () => {
    expect(
      validateEnv({
        NODE_ENV: 'test',
        DB_SYNCHRONIZE: 'true',
        DB_NAME: 'app_test',
      }).DB_SYNCHRONIZE,
    ).toBe(true);
    // 测试环境也要求库名以 _test 结尾，防止测试配置指向开发库
    expect(() =>
      validateEnv({ NODE_ENV: 'test', DB_SYNCHRONIZE: 'true', DB_NAME: 'app' }),
    ).toThrow(/_test 结尾/);
    for (const NODE_ENV of ['development', 'production'])
      expect(() => validateEnv({ NODE_ENV, DB_SYNCHRONIZE: 'true' })).toThrow(
        /DB_SYNCHRONIZE/,
      );
    expect(
      validateEnv({ NODE_ENV: 'production', DB_SYNCHRONIZE: 'false' })
        .DB_SYNCHRONIZE,
    ).toBe(false);
  });
});
