import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables, NodeEnv } from './env.validation.js';

export interface AuthConfig {
  jwtSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** 0 表示不启用 */
  idleSeconds: number;
  singleSession: boolean;
  lockMaxFails: number;
  lockIpMaxFails: number;
  lockSeconds: number;
  adminOrigins: string[];
  captchaMode: 'always' | 'after-failure';
}

/** 带类型的配置读取。业务代码不要直接读 process.env */
@Injectable()
export class AppConfigService {
  constructor(
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  get nodeEnv(): NodeEnv {
    return this.config.get('NODE_ENV', { infer: true });
  }
  get isProduction(): boolean {
    return this.nodeEnv === NodeEnv.Production;
  }
  get port(): number {
    return this.config.get('PORT', { infer: true });
  }
  get logLevel(): string {
    return this.config.get('LOG_LEVEL', { infer: true });
  }
  get swaggerEnabled(): boolean {
    return (
      this.config.get('SWAGGER_ENABLED', { infer: true }) ?? !this.isProduction
    );
  }
  get db(): {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    synchronize: boolean;
  } {
    return {
      host: this.config.get('DB_HOST', { infer: true }),
      port: this.config.get('DB_PORT', { infer: true }),
      name: this.config.get('DB_NAME', { infer: true }),
      user: this.config.get('DB_USER', { infer: true }),
      password: this.config.get('DB_PASSWORD', { infer: true }),
      synchronize: this.config.get('DB_SYNCHRONIZE', { infer: true }) ?? false,
    };
  }

  get redis(): {
    host: string;
    port: number;
    password: string | undefined;
    db: number;
    keyPrefix: string;
  } {
    return {
      host: this.config.get('REDIS_HOST', { infer: true }),
      port: this.config.get('REDIS_PORT', { infer: true }),
      password: this.config.get('REDIS_PASSWORD', { infer: true }) || undefined,
      db: this.config.get('REDIS_DB', { infer: true }),
      keyPrefix: this.config.get('REDIS_KEY_PREFIX', { infer: true }),
    };
  }

  get security(): { trustProxy: number; ipPerMinute: number } {
    return {
      trustProxy: this.config.get('TRUST_PROXY', { infer: true }),
      ipPerMinute: this.config.get('RATE_LIMIT_IP_PER_MINUTE', { infer: true }),
    };
  }

  get auth(): AuthConfig {
    const g = <K extends keyof EnvironmentVariables>(k: K) =>
      this.config.get(k, { infer: true }) as EnvironmentVariables[K];
    return {
      jwtSecret: g('AUTH_JWT_SECRET'),
      accessTtlSeconds: g('AUTH_ACCESS_TTL_MINUTES') * 60,
      refreshTtlSeconds: g('AUTH_REFRESH_TTL_DAYS') * 86400,
      idleSeconds: g('AUTH_IDLE_MINUTES') * 60,
      singleSession: g('AUTH_SINGLE_SESSION') ?? false,
      lockMaxFails: g('AUTH_LOCK_MAX_FAILS'),
      lockIpMaxFails: g('AUTH_LOCK_IP_MAX_FAILS'),
      lockSeconds: g('AUTH_LOCK_MINUTES') * 60,
      adminOrigins: (g('AUTH_ADMIN_ORIGINS') ?? '')
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean),
      captchaMode: g('AUTH_CAPTCHA_MODE'),
    };
  }

  /** 正在导出接口文档：不连数据库 */
  get openApiExport(): boolean {
    return this.config.get('OPENAPI_EXPORT', { infer: true }) ?? false;
  }
}
