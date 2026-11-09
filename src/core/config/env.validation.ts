import { plainToInstance, Transform } from 'class-transformer';
import {
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
  return env;
}
