import { readFileSync } from 'node:fs';

/** 版本号取自 package.json，接口文档和日志用 */
export const APP_VERSION: string = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;
