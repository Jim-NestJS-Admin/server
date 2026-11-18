import { plainToInstance, Transform } from 'class-transformer';
import {
  Matches,
  IsBoolean,
  IsIn,
  MinLength,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsInt,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum LogLevel {
  Fatal = 'fatal',
  Error = 'error',
  Warn = 'warn',
  Info = 'info',
  Debug = 'debug',
  Trace = 'trace',
  Silent = 'silent',
}

/** 只认 true / false（不区分大小写），其他写法原样保留交给 @IsBoolean 报错，避免拼错时被静默当成 false */
const toBool = ({ value }: { value: unknown }) => {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') return value;
  const v = value.trim().toLowerCase();
  return v === 'true' ? true : v === 'false' ? false : value;
};

/**
 * 启动时校验的环境变量。缺项或格式不对直接启动失败，不带病运行。
 * 新增配置项时同步写进 .env.example。
 */
export class EnvironmentVariables {
  @Transform(toBool) @IsOptional() @IsBoolean() OAUTH_ENABLED?: boolean;
  @Transform(toBool) @IsOptional() @IsBoolean() MCP_ENABLED?: boolean;
  @IsOptional() @IsString() MCP_ALLOWED_ORIGINS?: string;
  @IsOptional() @IsString() OAUTH_ISSUER?: string;
  @IsOptional() @IsString() OAUTH_JWKS?: string;
  @IsOptional() @IsString() OAUTH_COOKIE_KEYS?: string;
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @Matches(/^[a-fA-F0-9]{64}$/)
  OAUTH_MASTER_KEY?: string;
  @Transform(toBool) @IsOptional() @IsBoolean() OAUTH_DCR_ENABLED?: boolean;
  @Transform(toBool) @IsOptional() @IsBoolean() OAUTH_CIMD_ENABLED?: boolean;
  @IsOptional() @IsString() OAUTH_CIMD_HOSTS?: string;
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @Matches(/^[1-9]\d{0,19}$/)
  OAUTH_DCR_TENANT_ID?: string;
  /** AI专用加密主密钥，不复用登录或企业微信密钥。 */
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @Matches(/^[a-fA-F0-9]{64}$/)
  AI_MASTER_KEY?: string;

  @IsOptional()
  @IsString()
  AI_ANTHROPIC_API_KEY?: string;

  @IsOptional()
  @IsString()
  AI_DEFAULT_MODEL?: string;

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(8192)
  AI_MAX_OUTPUT_TOKENS: number = 2048;

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1000)
  @Max(120000)
  AI_TIMEOUT_MS: number = 60000;
  /** AES-256-GCM 主密钥：64位十六进制，独立于登录签名密钥。 */
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @Matches(/^[a-fA-F0-9]{64}$/)
  INTEGRATION_MASTER_KEY?: string;

  /** 首版一套部署只允许接入一个企业，由部署方固定企业ID。 */
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @Matches(/^[a-zA-Z0-9_-]{2,100}$/)
  WECOM_CORP_ID?: string;
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsEnum(LogLevel)
  LOG_LEVEL: LogLevel = LogLevel.Info;

  /** 接口文档页面（/docs）。未设置时：开发和测试环境开启，生产环境关闭 */
  @Transform(toBool)
  @IsOptional()
  @IsBoolean()
  SWAGGER_ENABLED?: boolean;

  @IsString()
  @IsNotEmpty()
  DB_HOST: string = '127.0.0.1';

  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  @Max(65535)
  DB_PORT: number = 3306;

  @IsString()
  @IsNotEmpty()
  DB_NAME!: string;

  @IsString()
  @IsNotEmpty()
  DB_USER!: string;

  @IsString()
  @IsNotEmpty()
  DB_PASSWORD!: string;

  /** 启动时按实体自动建表。只允许测试环境打开，开发和生产都用迁移（T10） */
  @Transform(toBool)
  @IsOptional()
  @IsBoolean()
  DB_SYNCHRONIZE?: boolean;

  /** 只读查询的超时（毫秒），超过由 MySQL 中止；0 表示不限。导出 1 万行也要在这个时间内完成 */
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt()
  @Min(0)
  DB_QUERY_TIMEOUT_MS: number = 30000;

  @IsString()
  @IsNotEmpty()
  REDIS_HOST: string = '127.0.0.1';

  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT: number = 6379;

  @IsOptional()
  @IsString()
  REDIS_PASSWORD?: string;

  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt()
  @Min(0)
  @Max(15)
  REDIS_DB: number = 0;

  /** 所有键的前缀。同一个 Redis 给多个环境用时靠它区分；端到端测试用单独的前缀，只清理自己的键 */
  @IsString()
  @IsNotEmpty()
  REDIS_KEY_PREFIX: string = 'jna:';

  /** 访问令牌签名密钥，至少 32 个字符，只放环境变量 */
  @IsString()
  @MinLength(32)
  AUTH_JWT_SECRET!: string;

  /** 访问令牌有效期（分钟），建议 30 */
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  @Max(1440)
  AUTH_ACCESS_TTL_MINUTES: number = 30;

  /** 刷新令牌（会话）有效期（天），建议 7 */
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  @Max(90)
  AUTH_REFRESH_TTL_DAYS: number = 7;

  /** 多长时间不操作自动退出（分钟），0 表示不启用 */
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt()
  @Min(0)
  AUTH_IDLE_MINUTES: number = 0;

  /** 同一账号只允许一处登录：新登录挤掉旧会话 */
  @Transform(toBool)
  @IsOptional()
  @IsBoolean()
  AUTH_SINGLE_SESSION?: boolean;

  /** 同一账号连续输错几次锁定 */
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  AUTH_LOCK_MAX_FAILS: number = 5;

  /** 同一 IP 连续输错几次锁定（防止一个 IP 轮流试很多账号） */
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  AUTH_LOCK_IP_MAX_FAILS: number = 20;

  /** 锁定时长（分钟）；失败计数也在这段时间后清零 */
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  AUTH_LOCK_MINUTES: number = 15;

  /** 允许调用刷新、退出、切换组织的后台前端地址（Origin），多个用逗号分隔。生产环境必填 */
  @IsOptional()
  @IsString()
  AUTH_ADMIN_ORIGINS?: string;

  /** 验证码出现时机：always 每次登录都要；after-failure 同一账号或 IP 输错过才要 */
  @IsIn(['always', 'after-failure'])
  AUTH_CAPTCHA_MODE: 'always' | 'after-failure' = 'always';

  /** 前面有几层受控的反向代理（0 表示直连，不信 X-Forwarded-For）。限流、登录计数按它取来源 IP */
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt()
  @Min(0)
  @Max(5)
  TRUST_PROXY: number = 0;

  /** 每个来源 IP 每分钟最多请求次数（总闸） */
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt()
  @Min(10)
  RATE_LIMIT_IP_PER_MINUTE: number = 600;

  /** 网站端前端地址（跨域白名单，/web 接口用），多个用逗号分隔。后台端直接用 AUTH_ADMIN_ORIGINS */
  @IsOptional()
  @IsString()
  CORS_WEB_ORIGINS?: string;

  /** APP / 小程序端的 H5 地址（跨域白名单，/app 接口用），多个用逗号分隔 */
  @IsOptional()
  @IsString()
  CORS_APP_ORIGINS?: string;

  /** 是否发送 HSTS 头；不填时生产环境开、其他环境关 */
  @Transform(toBool)
  @IsOptional()
  @IsBoolean()
  SECURITY_HSTS?: boolean;

  /** 代码生成器（T21）：只在开发环境生效；还要配两个输出根目录 */
  @Transform(toBool)
  @IsOptional()
  @IsBoolean()
  CODEGEN_ENABLED?: boolean;

  /** 本地开发工具固定使用的租户，不能从工具参数指定。 */
  @IsOptional()
  @Matches(/^[1-9]\d{0,19}$/)
  CODEGEN_TENANT_ID?: string;

  /** 代码生成写入的后端项目根目录（服务端写死，浏览器不能传路径） */
  @IsOptional()
  @IsString()
  CODEGEN_SERVER_ROOT?: string;

  /** 代码生成写入的前端项目根目录 */
  @IsOptional()
  @IsString()
  CODEGEN_ADMIN_ROOT?: string;

  /** 只给接口文档导出脚本用：导出时不连数据库。不要手动设置 */
  @Transform(toBool)
  @IsOptional()
  @IsBoolean()
  OPENAPI_EXPORT?: boolean;
}

export function validateEnv(
  raw: Record<string, unknown>,
): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, raw, {
    exposeDefaultValues: true,
  });
  const errors = validateSync(env, {
    skipMissingProperties: false,
    whitelist: false,
  });
  if (errors.length > 0) {
    const detail = errors
      .map(
        (e) =>
          `${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`,
      )
      .join('\n');
    throw new Error(`环境变量校验失败，服务不能启动：\n${detail}`);
  }
  if (env.DB_SYNCHRONIZE && env.NODE_ENV !== NodeEnv.Test) {
    throw new Error(
      '环境变量校验失败，服务不能启动：\nDB_SYNCHRONIZE 只允许在 NODE_ENV=test 时打开，开发和生产环境用迁移管理表结构',
    );
  }
  // 第二道保护：自动建表时库名必须是测试库，防止测试配置指向开发库或生产库
  if (env.DB_SYNCHRONIZE && !env.DB_NAME.endsWith('_test')) {
    throw new Error(
      `环境变量校验失败，服务不能启动：\nDB_SYNCHRONIZE 打开时 DB_NAME 必须以 _test 结尾（现在是 ${env.DB_NAME}）`,
    );
  }
  if (
    env.NODE_ENV === NodeEnv.Production &&
    !env.OPENAPI_EXPORT &&
    !env.AUTH_ADMIN_ORIGINS?.trim()
  ) {
    throw new Error(
      '环境变量校验失败，服务不能启动：\n生产环境必须设置 AUTH_ADMIN_ORIGINS（后台前端地址）',
    );
  }
  if (env.SWAGGER_ENABLED === undefined) {
    env.SWAGGER_ENABLED = env.NODE_ENV !== NodeEnv.Production;
  }
  if (env.MCP_ENABLED && !env.OAUTH_ENABLED && !env.OPENAPI_EXPORT)
    throw new Error('开启MCP必须先开启OAuth');
  for (const origin of (env.MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    try {
      const url = new URL(origin);
      if (
        url.origin !== origin ||
        !['https:', 'http:'].includes(url.protocol) ||
        (env.NODE_ENV === NodeEnv.Production && url.protocol !== 'https:')
      )
        throw new Error();
    } catch {
      throw new Error(
        'MCP_ALLOWED_ORIGINS须为逗号分隔的明确来源地址，生产环境须HTTPS',
      );
    }
  }
  if (env.OAUTH_ENABLED && !env.OPENAPI_EXPORT) {
    try {
      const issuer = new URL(env.OAUTH_ISSUER ?? '');
      if (
        issuer.pathname !== '/oauth' ||
        issuer.search ||
        issuer.hash ||
        issuer.username ||
        issuer.password
      )
        throw Error();
      if (
        issuer.protocol !== 'https:' &&
        !(
          env.NODE_ENV !== NodeEnv.Production &&
          issuer.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)
        )
      )
        throw Error();
      const jwks = JSON.parse(env.OAUTH_JWKS ?? '') as {
        keys: { kid?: string; kty?: string; d?: string }[];
      };
      if (
        !jwks.keys?.length ||
        jwks.keys.some((key) => !key.kid || !key.d || key.kty !== 'RSA')
      )
        throw Error();
      if (
        !env.OAUTH_MASTER_KEY ||
        !env.OAUTH_COOKIE_KEYS?.split(',').every((key) => key.length >= 32) ||
        !env.AUTH_ADMIN_ORIGINS
      )
        throw Error();
      if (env.OAUTH_DCR_ENABLED && !env.OAUTH_DCR_TENANT_ID) throw Error();
      if (
        env.OAUTH_CIMD_ENABLED &&
        (!env.OAUTH_DCR_TENANT_ID || !env.OAUTH_CIMD_HOSTS?.trim())
      )
        throw Error();
    } catch {
      throw new Error(
        'OAuth配置无效：请检查固定issuer、非对称JWKS、主密钥、Cookie密钥和后台地址；生产必须HTTPS',
      );
    }
  }
  return env;
}
