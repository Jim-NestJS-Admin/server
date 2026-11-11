import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import {
  LOCAL_TOOLS,
  type LocalCodegenTools,
  type LocalTool,
} from '../modules/codegen/local-tools.js';
import type { ModuleSpec } from '../modules/codegen/module-spec.js';
import { pathToFileURL } from 'node:url';
import { openLocalCodegen } from './codegen-runtime.js';

export async function callCodegenTool(
  tools: LocalCodegenTools,
  name: LocalTool,
  args: {
    spec?: unknown;
    table?: string;
    fingerprint?: string;
    overwrite?: string[];
  },
) {
  const result = await tools.call(
    name,
    args as {
      spec?: ModuleSpec;
      table?: string;
      fingerprint?: string;
      overwrite?: string[];
    },
  );
  const failed =
    result &&
    typeof result === 'object' &&
    (('valid' in result && !result.valid) ||
      ('failed' in result &&
        Array.isArray(result.failed) &&
        result.failed.length) ||
      ('skipped' in result &&
        Array.isArray(result.skipped) &&
        result.skipped.length));
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    ...(failed ? { isError: true } : {}),
  };
}

export function createCodegenMcp(tools: LocalCodegenTools) {
  const server = new McpServer({ name: 'jim-local-codegen', version: '1.0.0' });
  for (const name of LOCAL_TOOLS) {
    const inputSchema =
      name === 'describe_table'
        ? z
            .object({ table: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/) })
            .strict()
        : name === 'write_spec'
          ? z
              .object({
                spec: z.record(z.string(), z.unknown()),
                fingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
                overwrite: z.array(z.string()).max(50).optional(),
              })
              .strict()
          : ['validate_spec', 'preview_spec'].includes(name)
            ? z.object({ spec: z.record(z.string(), z.unknown()) }).strict()
            : z.object({}).strict();
    server.registerTool(
      name,
      {
        description:
          name === 'write_spec'
            ? '仅本地开发：携带 preview_spec 指纹写入白名单目录；不执行迁移或提交'
            : `仅本地开发的代码生成工具：${name}`,
        inputSchema,
        annotations: {
          readOnlyHint: name !== 'write_spec',
          destructiveHint: name === 'write_spec',
          openWorldHint: false,
        },
      },
      async (args) => {
        try {
          return await callCodegenTool(tools, name, args);
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: (error as Error).message }),
              },
            ],
          };
        }
      },
    );
  }
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const runtime = await openLocalCodegen();
    const handle = serveStdio(() => createCodegenMcp(runtime.tools), {
      onerror: (e) => console.error(e.message),
    });
    const close = async () => {
      await handle.close();
      await runtime.close();
    };
    process.stdin.once('end', () => {
      void close();
    });
    process.once('SIGINT', () => {
      void close();
    });
    process.once('SIGTERM', () => {
      void close();
    });
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
