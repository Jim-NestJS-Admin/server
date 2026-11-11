import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSafe } from './safe-writer.js';
import type { GeneratedFile } from './render-server.js';

/** 仅生成时动态加载各项目自己的 Prettier；生产启动不依赖开发依赖。 */
export async function formatFiles(
  files: GeneratedFile[],
  roots: Record<'server' | 'admin', string>,
): Promise<GeneratedFile[]> {
  const formatters = new Map<string, typeof import('prettier')>();
  const result: GeneratedFile[] = [];
  for (const file of files) {
    const root = roots[file.project];
    const path = resolveSafe(root, file.project, file.path);
    let formatter = formatters.get(root);
    if (!formatter) {
      const require = createRequire(join(root, 'package.json'));
      const loaded = (await import(
        pathToFileURL(require.resolve('prettier')).href
      )) as { default?: typeof import('prettier') } & typeof import('prettier');
      // Node 直接导入 Prettier 的 CJS 入口时 API 位于 default；测试转换器可能同时暴露具名导出。
      formatter = loaded.default ?? loaded;
      if (
        typeof formatter.resolveConfig !== 'function' ||
        typeof formatter.format !== 'function'
      )
        throw new Error('项目 Prettier 接口不可用');
      formatters.set(root, formatter);
    }
    const config = await formatter.resolveConfig(path, {
      editorconfig: true,
      useCache: false,
    });
    result.push({
      ...file,
      content: await formatter.format(file.content, {
        ...config,
        filepath: path,
      }),
    });
  }
  return result;
}
