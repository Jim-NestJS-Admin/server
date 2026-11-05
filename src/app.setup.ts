import type { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { requestIdMiddleware } from './core/context/request-id.js';
import { createValidationPipe } from './core/validation.js';

/**
 * main.ts、端到端测试、接口文档导出共用的应用配置，保证三处行为一致。
 * 全局拦截器和异常过滤在 CoreModule 里注册（APP_INTERCEPTOR / APP_FILTER）。
 */
export function configureApp(app: INestApplication): INestApplication {
  app.use(requestIdMiddleware);
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(createValidationPipe());
  return app;
}
