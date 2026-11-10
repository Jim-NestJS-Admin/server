import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppConfigService } from '../core/config/app-config.service.js';
import { RequestContext } from '../core/tenant/request-context.js';
import { CodegenService } from '../modules/codegen/codegen.service.js';
import { LocalCodegenTools } from '../modules/codegen/local-tools.js';
import { SystemDictionaryService } from '../modules/system-log/service/system-dictionary.service.js';

/** 不启动 HTTP 监听；禁用日志以免污染 MCP 的 stdout。 */
export async function openLocalCodegen() {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  process.env.LOG_LEVEL = 'silent';
  // 导入应用前先检查开关，生产环境不得加载开发工具或连接数据库。
  const { validateEnv } = await import('../core/config/env.validation.js');
  const env = validateEnv(process.env);
  if (
    env.NODE_ENV !== 'development' ||
    !env.CODEGEN_ENABLED ||
    env.OPENAPI_EXPORT ||
    !['localhost', '127.0.0.1', '::1'].includes(env.DB_HOST)
  )
    throw new Error(
      '本地生成工具仅允许开发环境、CODEGEN_ENABLED=true 和本机数据库',
    );
  const { AppModule } = await import('../app.module.js');
  const app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const { configureApp } = await import('../app.setup.js');
    configureApp(app);
    await app.init();
    const tools = new LocalCodegenTools(
      app.get(CodegenService),
      app.get(AppConfigService),
      app.get(RequestContext),
      app.get(SystemDictionaryService),
    );
    return { tools, close: () => app.close() };
  } catch (error) {
    await app.close();
    throw error;
  }
}
