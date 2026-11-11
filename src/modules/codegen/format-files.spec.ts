import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatFiles } from './format-files.js';
import { check } from 'prettier';

describe('生成文件使用各项目格式', () => {
  it('后端单引号/尾逗号，前端双引号/无尾逗号，格式化后可通过各自检查', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codegen-format-'));
    const roots = { server: join(root, 'server'), admin: join(root, 'admin') };
    for (const project of ['server', 'admin'] as const) {
      await mkdir(roots[project]);
      await writeFile(
        join(roots[project], 'package.json'),
        '{"type":"module"}',
      );
      await symlink(
        join(process.cwd(), 'node_modules'),
        join(roots[project], 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await writeFile(
        join(roots[project], '.prettierrc'),
        JSON.stringify({
          singleQuote: project === 'server',
          trailingComma: project === 'server' ? 'all' : 'none',
        }),
      );
    }
    const files = await formatFiles(
      [
        {
          project: 'server',
          path: 'src/modules/sample/sample.ts',
          content:
            'export const name="客户"; export const settings={ first: "one", second: "two" };',
        },
        {
          project: 'admin',
          path: 'src/views/sample/index.vue',
          content:
            '<script setup lang="ts">const title=\'客户\'</script>\n<template><div>{{title}}</div></template>',
        },
      ],
      roots,
    );
    expect(files[0].content).toContain("name = '客户'");
    expect(files[1].content).toContain('title = "客户"');
    for (const file of files)
      expect(
        await check(file.content, {
          filepath: join(roots[file.project], file.path),
          singleQuote: file.project === 'server',
          trailingComma: file.project === 'server' ? 'all' : 'none',
        }),
      ).toBe(true);
    // 原生 Node 不经过 Vite 的 CJS/ESM 转换，防止测试环境掩盖 Prettier default 导出差异。
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    for (const name of ['format-files', 'safe-writer']) {
      const source = await readFile(
        new URL(`./${name}.ts`, import.meta.url),
        'utf8',
      );
      await writeFile(
        join(root, `${name}.js`),
        ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2023,
          },
        }).outputText,
      );
    }
    const script = `import {formatFiles} from ${JSON.stringify(pathToFileURL(join(root, 'format-files.js')).href)}; const result=await formatFiles([{project:'server',path:'src/modules/sample/native.ts',content:'export const name="native";'}],${JSON.stringify(roots)}); process.stdout.write(JSON.stringify(result));`;
    const native = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { windowsHide: true, timeout: 10000 },
    );
    expect(
      (JSON.parse(native.stdout) as { content: string }[])[0].content,
    ).toBe("export const name = 'native';\n");
  });
});
