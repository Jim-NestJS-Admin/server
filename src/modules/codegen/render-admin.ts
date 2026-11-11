import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type ts from 'typescript';
import { crudResourceName } from '../../core/crud/crud-meta.js';
import type { CodegenConfig } from './codegen.types.js';
import type { GeneratedFile } from './render-server.js';

/** 前端模板（admin 项目 codegen-templates/，Codex 维护，契约 codegen.md 第 6 节） */
export interface AdminTemplates {
  page: string;
}

const TEMPLATE_FILES = { page: 'page.vue.tpl' };

/** 从前端项目根目录读模板；文件名固定，不接受浏览器传入的路径 */
export async function loadAdminTemplates(
  adminRoot: string,
): Promise<AdminTemplates> {
  if (!adminRoot)
    throw new Error('没有配置 CODEGEN_ADMIN_ROOT，读不到前端模板');
  const dir = join(adminRoot, 'codegen-templates');
  const read = (f: string) =>
    readFile(join(dir, f), 'utf8').catch(() => {
      throw new Error(`前端模板不存在：codegen-templates/${f}`);
    });
  return {
    page: await read(TEMPLATE_FILES.page),
  };
}

/** 前端页面组件键（菜单 component、导航白名单、页面偏好的 pageKey 都用它）：crm:customer → crm/customer */
export const adminComponentKey = (c: Pick<CodegenConfig, 'permPrefix'>) =>
  c.permPrefix.replace(/:/g, '/');

/**
 * 只做固定占位符替换：{{name}}（不带空格）换成服务端算好的值，不执行任何表达式。
 * 变量名以 Json / Expression 结尾，模板里出现不认识的这类变量直接报错，不生成半成品；
 * Vue 自己的插值（如 {{ t('x') }}）不受影响。
 */
function fill(tpl: string, vars: Record<string, string>, name: string): string {
  return tpl.replace(
    /\{\{([A-Za-z]+(?:Json|Expression))\}\}/g,
    (_m, k: string) => {
      if (!Object.hasOwn(vars, k))
        throw new Error(`前端模板 ${name} 里有不认识的变量 {{${k}}}`);
      return vars[k];
    },
  );
}

/**
 * 前端文件：src/views/<module>/<business>/index.vue（标签来自后端 schema，不生成无人引用的 TS 语言包）。
 * 变量按契约第 6 节生成：JSON 变量一律 JSON.stringify；pageKeyExpression 只由校验过的权限前缀转成单引号表达式。
 */
export function renderAdmin(
  c: CodegenConfig,
  t: AdminTemplates,
): GeneratedFile[] {
  const key = adminComponentKey(c);
  // 权限前缀已过 codegen.types 的 PERM 校验，这里再挡一次：单引号表达式里只能有这些字符
  if (!/^[a-z][a-z0-9/-]*$/.test(key))
    throw new Error(`权限前缀不能用作页面键：${c.permPrefix}`);
  const name = crudResourceName(key);
  const vars: Record<string, string> = {
    operationPrefixJson: JSON.stringify(
      name.charAt(0).toLowerCase() + name.slice(1),
    ),
    resourceJson: JSON.stringify(c.permPrefix),
    pageKeyExpression: `'${key}'`,
    labelJson: JSON.stringify(c.label),
    fieldsJson: JSON.stringify(
      Object.fromEntries(c.fields.map((f) => [f.name, f.label])),
    ),
  };
  return [
    {
      project: 'admin',
      path: `src/views/${c.module}/${c.business}/index.vue`,
      content: fill(t.page, vars, TEMPLATE_FILES.page),
    },
  ];
}

/** 生成后必须人工完成的步骤：生成器不自动注册、不执行命令，也不假装页面已经上线 */
export function manualSteps(
  c: CodegenConfig,
  state?: {
    files: string[];
    moduleRegistered: boolean;
    viewRegistered: boolean;
  },
): string[] {
  const name = `${c.business.replace(/_(.)/g, (_m, x: string) => x.toUpperCase())}`;
  const mod = `${name.charAt(0).toUpperCase()}${name.slice(1)}Module`;
  const key = adminComponentKey(c);
  return [
    ...(!state?.moduleRegistered
      ? [
          `后端：在 src/app.module.ts 的 imports 里加上 ${mod}（src/modules/${c.module}/${c.business}.module.ts）`,
        ]
      : []),
    ...(!state ||
    state.files.some((file) => file.startsWith('src/database/migrations/'))
      ? [
          `后端：确认后执行迁移（src/database/migrations 里本次生成的文件，并登记到迁移列表），生成器不会自动执行`,
        ]
      : []),
    `后端：运行 pnpm openapi:export 并提交 openapi/admin.json`,
    `前端：运行 pnpm gen:api 重新生成接口代码`,
    ...(!state?.viewRegistered
      ? [
          `前端：在 src/platform/navigation.ts 的 navigationViews 里登记 ["${key}", () => import("@/views/${c.module}/${c.business}/index.vue")]`,
        ]
      : []),
    ...(!state || state.files.some((file) => file.endsWith('.menu.json'))
      ? [
          `菜单：按 src/modules/${c.module}/${c.business}.menu.json 初始化菜单和按钮权限（组件键 ${key}），再给角色授权`,
        ]
      : []),
    `后端：重新构建并重启服务后联调`,
  ];
}

/** 从语法树读取登记情况，注释里的示例不会被当成已经登记。 */
export async function contextualSteps(
  c: CodegenConfig,
  roots: Record<'server' | 'admin', string>,
  files: string[],
): Promise<string[]> {
  const { default: ts } = await import('typescript');
  const read = async (path: string) =>
    readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
  const [app, navigation] = await Promise.all([
    read(join(roots.server, 'src/app.module.ts')),
    read(join(roots.admin, 'src/platform/navigation.ts')),
  ]);
  const mod =
    c.business.replace(/(^|_)([a-z0-9])/g, (_m, _prefix, letter: string) =>
      letter.toUpperCase(),
    ) + 'Module';
  let moduleRegistered = false,
    viewRegistered = false;
  const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
    visit(node);
    node.forEachChild((child) => walk(child, visit));
  };
  walk(
    ts.createSourceFile('app.ts', app, ts.ScriptTarget.Latest, true),
    (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Module'
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg))
          for (const property of arg.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              property.name.getText() === 'imports' &&
              ts.isArrayLiteralExpression(property.initializer)
            )
              moduleRegistered ||= property.initializer.elements.some(
                (item) => ts.isIdentifier(item) && item.text === mod,
              );
          }
      }
    },
  );
  walk(
    ts.createSourceFile(
      'navigation.ts',
      navigation,
      ts.ScriptTarget.Latest,
      true,
    ),
    (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'navigationViews' &&
        node.initializer
      ) {
        walk(node.initializer, (item) => {
          if (
            ts.isArrayLiteralExpression(item) &&
            item.elements.length === 2 &&
            ts.isStringLiteral(item.elements[0]) &&
            item.elements[0].text === adminComponentKey(c)
          )
            viewRegistered = true;
        });
      }
    },
  );
  return manualSteps(c, { files, moduleRegistered, viewRegistered });
}
