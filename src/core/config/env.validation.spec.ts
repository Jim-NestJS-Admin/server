import { NodeEnv, validateEnv } from './env.validation.js';

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

  it('端口不是数字时启动失败', () => {
    expect(() => validateEnv({ PORT: 'abc' })).toThrow(
      /环境变量校验失败[\s\S]*PORT/,
    );
  });

  it('非法的运行环境和日志级别启动失败', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => validateEnv({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});
