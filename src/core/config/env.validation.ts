import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsEnum,
  IsInt,
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

const toBool = ({ value }: { value: unknown }) =>
  value === undefined || value === ''
    ? undefined
    : typeof value === 'string'
      ? value.toLowerCase() === 'true'
      : value;

/**
 * 启动时校验的环境变量。缺项或格式不对直接启动失败，不带病运行。
 * 新增配置项时同步写进 .env.example。数据库、Redis 等配置在用到它们的任务里再加入（T03、T04）。
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
  if (env.SWAGGER_ENABLED === undefined) {
    env.SWAGGER_ENABLED = env.NODE_ENV !== NodeEnv.Production;
  }
  return env;
}
