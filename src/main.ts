import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { APP_VERSION } from './app.version.js';
import { AppConfigService } from './core/config/app-config.service.js';
import { setupSwagger } from './core/swagger/swagger.js';

async function bootstrap() {
  // 关掉默认的请求体解析，用 configureApp 里带上限的那一套（T25）
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  configureApp(app);
  const config = app.get(AppConfigService);
  if (config.swaggerEnabled) setupSwagger(app, APP_VERSION);
  app.enableShutdownHooks();
  await app.listen(config.port);
}
await bootstrap();
