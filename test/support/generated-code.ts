import ts from 'typescript';
import * as orm from 'typeorm';
import * as validator from 'class-validator';
import * as crud from '../../src/core/crud/index.js';
import * as fieldPerm from '../../src/core/field-perm/field-perm.decorator.js';
import type { GeneratedFile } from '../../src/modules/codegen/render-server.js';

/** 仅测试：把真实生成文件编译成 CommonJS，在固定依赖映射下加载，验证装饰器和实体契约。 */
export function loadGenerated(files: GeneratedFile[]) {
  const loaded = new Map<string, Record<string, unknown>>();
  for (const file of files.filter(
    (f) => f.path.endsWith('.ts') && !f.path.endsWith('.module.ts'),
  )) {
    const compiled = ts.transpileModule(file.content, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
      reportDiagnostics: true,
    });
    const errors =
      compiled.diagnostics?.filter(
        (d) => d.category === ts.DiagnosticCategory.Error,
      ) ?? [];
    if (errors.length)
      throw new Error(
        errors
          .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
          .join('\n'),
      );
    const exports: Record<string, unknown> = {};
    const require = (name: string) => {
      if (name === 'typeorm') return orm;
      if (name === 'class-validator') return validator;
      if (name.endsWith('/core/crud/index.js')) return crud;
      if (name.endsWith('/field-perm.decorator.js')) return fieldPerm;
      const target = [...loaded.entries()].find(([path]) =>
        name.endsWith('/' + path.split('/').at(-1)!.replace(/\.ts$/, '.js')),
      );
      if (target) return target[1];
      throw new Error(`测试不允许加载未知依赖：${name}`);
    };
    // 只执行本测试刚由可信模板生成的代码，不提供任意模块加载能力。
    // eslint-disable-next-line typescript/no-implied-eval -- 仅执行可信模板的测试产物，依赖由上面的固定映射提供。
    new Function('require', 'exports', compiled.outputText)(require, exports);
    loaded.set(file.path, exports);
  }
  return loaded;
}
