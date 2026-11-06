import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { requestIdMiddleware } from './core/context/request-id.js';
import { createValidationPipe } from './core/validation.js';
import { AppConfigService } from './core/config/app-config.service.js';

/**
 * main.ts、端到端测试、接口文档导出共用的应用配置，保证三处行为一致。
 * 全局拦截器和异常过滤在 CoreModule 里注册（APP_INTERCEPTOR / APP_FILTER）。
 */
export function configureApp(app: INestApplication): INestApplication {
  // 只信任配置的受控代理层数（T25）：直连时不信 X-Forwarded-For，伪造的来源 IP 绕不过限流
  const trust = app.get(AppConfigService).security.trustProxy;
  (
    app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }
  ).set('trust proxy', trust > 0 ? trust : false);
  app.use(requestIdMiddleware);
  // 请求体上限（T25）：JSON / 表单 1MB；文件上传由文件模块自己的限制控制
  const express = app as NestExpressApplication;
  if (typeof express.useBodyParser === 'function') {
    express.useBodyParser('json', { limit: '1mb' });
    express.useBodyParser('urlencoded', { limit: '1mb', extended: true });
  }
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(createValidationPipe());
  return app;
}
