import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
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
 * 新增配置项时同步写进 .env.example。Redis 配置在 T04 加入。
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
  if (env.SWAGGER_ENABLED === undefined) {
    env.SWAGGER_ENABLED = env.NODE_ENV !== NodeEnv.Production;
  }
  return env;
}
