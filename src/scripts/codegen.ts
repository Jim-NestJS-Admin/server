import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { ModuleSpec } from '../modules/codegen/module-spec.js';
import type { LocalCodegenTools } from '../modules/codegen/local-tools.js';
import { openLocalCodegen } from './codegen-runtime.js';

/** 可注入同一工具入口，便于验证 CLI 与 MCP 的规格结果一致。 */
export async function runCodegen(args: string[], tools: LocalCodegenTools) {
  const [file, ...flags] = args;
  let mode: string | undefined, fingerprint: string | undefined;
  const overwrite: string[] = [];
  const usage = () =>
    new Error(
      '用法：pnpm codegen <spec.json> --check | --preview | --write --confirm <指纹> [--overwrite <project:path>] [--json]',
    );
  if (!file || file.startsWith('--')) throw usage();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (['--check', '--preview', '--write'].includes(flag)) {
      if (mode) throw usage();
      mode = flag;
    } else if (flag === '--confirm' || flag === '--overwrite') {
      const value = flags[++i];
      if (!value || value.startsWith('--')) throw usage();
      if (flag === '--confirm') {
        if (fingerprint) throw usage();
        fingerprint = value;
      } else overwrite.push(value);
    } else if (flag !== '--json') throw usage();
  }
  if (!mode || (mode !== '--write' && (fingerprint || overwrite.length)))
    throw usage();
  const spec = JSON.parse(await readFile(file, 'utf8')) as ModuleSpec;
  if (mode === '--check') return tools.call('validate_spec', { spec });
  if (mode === '--preview') return tools.call('preview_spec', { spec });
  if (!fingerprint) throw new Error('写入必须用 --confirm 携带预览指纹');
  return tools.call('write_spec', { spec, fingerprint, overwrite });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let runtime: Awaited<ReturnType<typeof openLocalCodegen>> | undefined;
  try {
    runtime = await openLocalCodegen();
    const result = await runCodegen(process.argv.slice(2), runtime.tools);
    console.log(
      process.argv.includes('--json')
        ? JSON.stringify(result)
        : `代码生成结果（写入后仍需人工注册模块与执行迁移）：\n${JSON.stringify(result, null, 2)}`,
    );
    if (
      result &&
      typeof result === 'object' &&
      (('valid' in result && !result.valid) ||
        ('failed' in result &&
          Array.isArray(result.failed) &&
          result.failed.length) ||
        ('skipped' in result &&
          Array.isArray(result.skipped) &&
          result.skipped.length))
    )
      process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ error: (error as Error).message }));
    process.exitCode = 1;
  } finally {
    await runtime?.close();
  }
}
