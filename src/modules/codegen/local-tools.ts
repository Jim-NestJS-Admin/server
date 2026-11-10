import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CodegenService } from './codegen.service.js';
import type { ModuleSpec } from './module-spec.js';
import { validateSpec } from './module-spec.js';
import type { AppConfigService } from '../../core/config/app-config.service.js';
import type { RequestContext } from '../../core/tenant/request-context.js';
import type { SystemDictionaryService } from '../system-log/service/system-dictionary.service.js';

export const LOCAL_TOOLS = [
  'list_tables',
  'describe_table',
  'list_modules',
  'list_dictionaries',
  'list_field_types',
  'validate_spec',
  'preview_spec',
  'write_spec',
  'run_checks',
] as const;
export type LocalTool = (typeof LOCAL_TOOLS)[number];
const execute = promisify(execFile);

/** CLI 和 stdio 使用同一个入口；没有端口、任意命令、任意路径或客户端租户参数。 */
export class LocalCodegenTools {
  constructor(
    private readonly service: CodegenService,
    private readonly config: AppConfigService,
    private readonly context: RequestContext,
    private readonly dictionaries: SystemDictionaryService,
  ) {}
  async call(
    tool: LocalTool,
    args: { spec?: ModuleSpec; table?: string; fingerprint?: string } = {},
  ) {
    if (
      !this.config.codegen.enabled ||
      this.config.openApiExport ||
      !['localhost', '127.0.0.1', '::1'].includes(this.config.db.host)
    )
      throw new Error(
        '本地生成工具仅允许开发环境、CODEGEN_ENABLED=true 和本机数据库',
      );
    return this.context.run(
      { tenantId: this.config.codegen.tenantId },
      async () => {
        switch (tool) {
          case 'list_tables':
            return this.service.tables();
          case 'describe_table': {
            if (!args.table || !/^[a-z][a-z0-9_]{0,47}$/.test(args.table))
              throw new Error('表名格式无效');
            return this.service.importSpec([args.table]);
          }
          case 'list_modules':
            return this.service.list();
          case 'list_dictionaries':
            return this.dictionaries.catalog();
          case 'list_field_types':
            return this.service.fieldTypes();
          case 'validate_spec': {
            const errors = validateSpec(args.spec);
            return { valid: !errors.length, errors };
          }
          case 'preview_spec':
            return this.service.previewSpec(args.spec!);
          case 'write_spec': {
            if (
              !args.fingerprint ||
              !/^[A-Za-z0-9_-]{43}$/.test(args.fingerprint)
            )
              throw new Error('写入必须携带预览返回的指纹');
            return this.service.writeSpec(args.spec!, args.fingerprint);
          }
          case 'run_checks': {
            const results = [];
            for (const command of [
              'pnpm typecheck',
              'pnpm lint',
              'pnpm exec vitest run src/modules/codegen',
            ]) {
              try {
                const result =
                  process.platform === 'win32'
                    ? await execute('cmd.exe', ['/d', '/s', '/c', command], {
                        cwd: this.config.codegen.serverRoot,
                        windowsHide: true,
                        timeout: 120000,
                        maxBuffer: 1024 * 1024,
                      })
                    : await execute('pnpm', command.split(' ').slice(1), {
                        cwd: this.config.codegen.serverRoot,
                        timeout: 120000,
                        maxBuffer: 1024 * 1024,
                      });
                results.push({
                  command,
                  ok: true,
                  output: result.stdout.slice(-12000),
                });
              } catch (error) {
                const e = error as { stdout?: string; stderr?: string };
                results.push({
                  command,
                  ok: false,
                  output: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(-12000),
                });
              }
            }
            return results;
          }
          default:
            throw new Error('未知开发工具');
        }
      },
    );
  }
}
