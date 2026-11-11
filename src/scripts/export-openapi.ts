import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { INestApplication } from '@nestjs/common';

/** 导出接口文档到 openapi/admin.json（相对 server 项目根目录）。改了接口必须运行并提交 */
export async function exportOpenApi(
  outFile = resolve(process.cwd(), 'openapi/admin.json'),
  excludedModules: string[] = [],
): Promise<string> {
  // 导出时不需要访问日志，也不连数据库；模块在设置环境变量之后再加载，配置校验才能读到。
  // 数据库配置给占位值，只为通过启动校验，导出过程不会用它们连接。
  process.env.LOG_LEVEL ??= 'silent';
  process.env.OPENAPI_EXPORT = 'true';
  // 接口文档固定包含开发环境才有的代码生成器接口（前端生成器页面要用），本机和 CI 导出结果一致
  process.env.NODE_ENV = 'development';
  process.env.CODEGEN_ENABLED = 'true';
  process.env.DB_NAME ??= 'openapi_export';
  process.env.DB_USER ??= 'openapi_export';
  process.env.DB_PASSWORD ??= 'openapi_export';
  // 导出文档不签发令牌、不出题，密钥只为通过启动校验
  for (const k of ['AUTH_JWT_SECRET'])
    process.env[k] ??= 'openapi-export-placeholder-secret-0000';
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../app.setup.js');
  const { APP_VERSION } = await import('../app.version.js');
  const { buildOpenApiDocument, stableStringify } =
    await import('../core/swagger/swagger.js');

  const app: INestApplication = await NestFactory.create(AppModule, {
    logger: false,
  });
  let json: string;
  try {
    configureApp(app);
    await app.init();
    json = stableStringify(
      buildOpenApiDocument(app, APP_VERSION, excludedModules),
    );
  } finally {
    await app.close();
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, json);
  return outFile;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      'exclude-module': { type: 'string', multiple: true },
    },
    strict: true,
  });
  const file = await exportOpenApi(
    values.output ? resolve(values.output) : undefined,
    values['exclude-module'],
  );
  console.log(`接口文档已导出：${file}`);
}
