import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables, NodeEnv } from './env.validation.js';

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
}
