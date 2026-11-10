import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { ModuleSpec } from '../modules/codegen/module-spec.js';
import type { LocalCodegenTools } from '../modules/codegen/local-tools.js';
import { openLocalCodegen } from './codegen-runtime.js';

/** 可注入同一工具入口，便于验证 CLI 与 MCP 的规格结果一致。 */
export async function runCodegen(args: string[], tools: LocalCodegenTools) {
  const [file, ...flags] = args;
  const modes = flags.filter((a) =>
    ['--check', '--preview', '--write'].includes(a),
  );
  if (
    !file ||
    modes.length !== 1 ||
    flags.some(
      (a, i) =>
        !['--check', '--preview', '--write', '--json', '--confirm'].includes(
          a,
        ) && flags[i - 1] !== '--confirm',
    )
  )
    throw new Error(
      '用法：pnpm codegen <spec.json> --check | --preview | --write --confirm <指纹> [--json]',
    );
  const spec = JSON.parse(await readFile(file, 'utf8')) as ModuleSpec;
  if (modes[0] === '--check') return tools.call('validate_spec', { spec });
  if (modes[0] === '--preview') return tools.call('preview_spec', { spec });
  const at = flags.indexOf('--confirm');
  if (at < 0 || !flags[at + 1])
    throw new Error('写入必须用 --confirm 携带预览指纹');
  return tools.call('write_spec', { spec, fingerprint: flags[at + 1] });
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
