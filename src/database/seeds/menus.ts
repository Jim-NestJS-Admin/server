import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 一个页面菜单：组件键要在前端 navigationViews 白名单里，权限码要由后端声明 */
export interface PageSeed {
  scope?: 'platform' | 'tenant';
  title: string;
  path: string;
  component: string;
  /** 打开页面需要的权限码 */
  permission: string;
  /** 这些前缀下的其他权限码作为页面上的按钮，如 system:user */
  buttonPrefixes: string[];
  /** 跨资源的最小依赖按钮，不扩成整个资源的管理权限。 */
  buttonPermissions?: string[];
  icon?: string;
  hidden?: boolean;
}

export interface DirectorySeed {
  scope?: 'platform' | 'tenant';
  title: string;
  path: string;
  icon?: string;
  pages: PageSeed[];
}

const crud = (title: string, key: string, extra: string[] = []): PageSeed => ({
  title,
  path: `/${key}`,
  component: key,
  permission: `${key.replace(/\//g, ':')}:page`,
  buttonPrefixes: [key.replace(/\//g, ':'), ...extra],
});

/**
 * 默认菜单（T10）：组织与权限、系统配置、日志审计、开发工具。组件键和前端 src/platform/navigation.ts 的 navigationViews 一一对应。
 * 权限码没有在后端声明的页面（例如没开启代码生成器）初始化时跳过，不写入无效菜单。
 */
export const DEFAULT_MENUS: DirectorySeed[] = [
  {
    title: '表单与流程',
    path: '/forms',
    icon: 'ri:file-list-3-line',
    pages: [
      crud('表单定义', 'form/definition'),
      crud('提交记录', 'form/submission'),
      crud('流程管理', 'workflow/definition', ['workflow:directory']),
      {
        ...crud('审批工作台', 'workflow/instance', [
          'workflow:task',
          'workflow:record',
          'workflow:directory',
        ]),
        component: 'workflow/workbench',
        buttonPermissions: [
          'form:submission:add',
          'form:submission:page',
          'file:asset:upload',
        ],
      },
    ],
  },
  {
    title: '平台管理',
    path: '/platform',
    icon: 'ri:global-line',
    scope: 'platform',
    pages: [
      crud('租户管理', 'platform/tenant'),
      crud('套餐管理', 'platform/package'),
      crud('菜单管理', 'system/menu'),
    ],
  },
  {
    title: '组织与权限',
    path: '/system',
    icon: 'ri:team-line',
    pages: [
      crud('用户管理', 'system/user'),
      crud('组织管理', 'system/org'),
      crud('角色管理', 'system/role'),
      { ...crud('角色分配', 'system/user-role'), hidden: true },
      { ...crud('上级关系', 'system/user-supervisor'), hidden: true },
      {
        ...crud('字段权限', 'system/field', ['system:role-field']),
        hidden: true,
      },
    ],
  },
  {
    title: '系统配置',
    path: '/settings',
    icon: 'ri:settings-3-line',
    pages: [
      crud('字典管理', 'system/dict-type'),
      { ...crud('字典项', 'system/dict-item'), hidden: true },
      crud('系统参数', 'system/parameter'),
      crud('编码规则', 'system/code-rule', ['system:code-sequence']),
      {
        title: '模块配置',
        path: '/system/page-config',
        component: 'system/page-config',
        permission: 'system:page-config:info',
        buttonPrefixes: ['system:page-config'],
      },
    ],
  },
  {
    title: '日志审计',
    path: '/audit',
    icon: 'ri:file-search-line',
    pages: [
      crud('操作日志', 'system/operation-log'),
      crud('登录日志', 'system/login-log'),
    ],
  },
  {
    title: '开发工具',
    path: '/dev',
    icon: 'ri:code-box-line',
    pages: [
      {
        title: '代码生成',
        path: '/dev/codegen',
        component: 'dev/codegen',
        permission: 'dev:codegen:list',
        buttonPrefixes: ['dev:codegen'],
      },
    ],
  },
];

/** 按钮名称：按权限码最后一段 */
const ACTION_TITLES: Record<string, string> = {
  page: '查看',
  list: '查看',
  info: '详情',
  add: '新增',
  update: '修改',
  delete: '删除',
  recycle: '回收站',
  restore: '恢复',
  purge: '彻底删除',
  export: '导出',
  save: '保存',
  write: '写入文件',
  read: '下载',
  upload: '上传',
  validate: '校验填写',
  publish: '发布流程',
  approve: '同意',
  reject: '驳回',
  transfer: '转交',
  withdraw: '撤回',
  resubmit: '重新提交',
  urge: '催办',
  'reset-password': '重置密码',
};

export const buttonTitle = (code: string): string => {
  const action = code.split(':').at(-1) ?? code;
  return ACTION_TITLES[action] ?? action;
};

/** 代码生成器写出的 src/modules/<模块>/<业务>.menu.json（见 render-server.ts 的 menu()） */
export interface GeneratedMenu {
  page: { title: string; path: string; component: string; permission: string };
  buttons: { title: string; permission: string }[];
}

/** 读 src/modules 下一层目录里的 *.menu.json；格式不对的文件报错，不静默跳过 */
export async function loadGeneratedMenus(
  modulesDir: string,
): Promise<{ file: string; menu: GeneratedMenu }[]> {
  const out: { file: string; menu: GeneratedMenu }[] = [];
  let mods: string[];
  try {
    mods = await readdir(modulesDir);
  } catch {
    return out;
  }
  for (const m of mods.sort()) {
    let files: string[];
    try {
      files = await readdir(join(modulesDir, m));
    } catch {
      continue;
    }
    for (const f of files.filter((x) => x.endsWith('.menu.json')).sort()) {
      const file = join(modulesDir, m, f);
      const menu = JSON.parse(await readFile(file, 'utf8')) as GeneratedMenu;
      if (
        !menu?.page?.title ||
        !menu.page.path ||
        !menu.page.component ||
        !menu.page.permission ||
        !Array.isArray(menu.buttons)
      )
        throw new Error(`菜单文件格式不对：${file}`);
      out.push({ file, menu });
    }
  }
  return out;
}
