import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { INestApplication } from '@nestjs/common';

/** 导出接口文档到 openapi/admin.json（相对 server 项目根目录）。改了接口必须运行并提交 */
export async function exportOpenApi(
  outFile = resolve(process.cwd(), 'openapi/admin.json'),
): Promise<string> {
  // 导出时不需要访问日志；模块在设置环境变量之后再加载，配置校验才能读到
  process.env.LOG_LEVEL ??= 'silent';
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../app.setup.js');
  const { APP_VERSION } = await import('../app.version.js');
  const { buildOpenApiDocument, stableStringify } =
    await import('../core/swagger/swagger.js');

  const app: INestApplication = await NestFactory.create(AppModule, {
    logger: false,
  });
  configureApp(app);
  await app.init();
  const json = stableStringify(buildOpenApiDocument(app, APP_VERSION));
  await app.close();
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, json);
  return outFile;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const file = await exportOpenApi();
  console.log(`接口文档已导出：${file}`);
}
