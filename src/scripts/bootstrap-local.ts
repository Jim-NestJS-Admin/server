import { FormSubmission1794621600000 } from '../database/migrations/1794621600000-FormSubmission.js';
import { WorkflowDefinition1794625200000 } from '../database/migrations/1794625200000-WorkflowDefinition.js';
import { CommonCodeRuleStatus1794618000000 } from '../database/migrations/1794618000000-CommonCodeRuleStatus.js';
import { DictionaryTags1794614400000 } from '../database/migrations/1794614400000-DictionaryTags.js';
import { CodegenModuleSpec1794312000000 } from '../database/migrations/1794312000000-CodegenModuleSpec.js';
import { TenantCatalog1794412800000 } from '../database/migrations/1794412800000-TenantCatalog.js';
import { PlatformMenus1794412800001 } from '../database/migrations/1794412800001-PlatformMenus.js';
import { FormDefinition1794470400000 } from '../database/migrations/1794470400000-FormDefinition.js';
import { TenantSeedService } from '../modules/tenant/service/tenant-seed.service.js';
import { SharedDictionaries1794279600000 } from '../database/migrations/1794279600000-SharedDictionaries.js';
import { PLATFORM_TENANT_ID } from '../core/tenant/tenant.constants.js';
import 'reflect-metadata';
import { CodeRules1794528000000 } from '../database/migrations/1794528000000-CodeRules.js';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module.js';
import { validateEnv, NodeEnv } from '../core/config/env.validation.js';
import { SnakeNamingStrategy } from '../core/database/naming.strategy.js';
import { applyUtcSessions } from '../core/database/utc-session.js';
import { RequestContext } from '../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../core/tenant/tenant-repository.js';
import { DEFAULT_TENANT_ID } from '../core/tenant/tenant.constants.js';
import {
  PasswordHasher,
  passwordBytes,
  PASSWORD_MAX_BYTES,
  normalizeUsername,
} from '../core/auth/password.js';
import { PermissionService } from '../core/permission/permission.service.js';
import { InitialSystem1793926800000 } from '../database/migrations/1793926800000-InitialSystem.js';
import { SystemRelationships1793930400000 } from '../database/migrations/1793930400000-SystemRelationships.js';
import { SystemLogs1793937600000 } from '../database/migrations/1793937600000-SystemLogs.js';
import { SystemFields1793941200000 } from '../database/migrations/1793941200000-SystemFields.js';
import { CreateFileAsset1793923200000 } from '../database/migrations/1793923200000-CreateFileAsset.js';
import { FileAssetOrganization1793934000000 } from '../database/migrations/1793934000000-FileAssetOrganization.js';
import { CoreTables1793944800000 } from '../database/migrations/1793944800000-CoreTables.js';
import {
  SystemMenu,
  SystemOrg,
  SystemRole,
  SystemUser,
  SystemUserRole,
} from '../modules/system/entity/system.entity.js';
import {
  SystemDictItem,
  SystemDictType,
} from '../modules/system-log/entity/system-log.entity.js';
import { PermissionRegistry } from '../core/permission/permission-registry.js';
import type { EntityManager } from 'typeorm';
import {
  buttonTitle,
  DEFAULT_MENUS,
  loadGeneratedMenus,
  type GeneratedMenu,
} from '../database/seeds/menus.js';

/**
 * 本机开发库初始化（T10）：执行迁移 → 初始化菜单和按钮（可重复执行，只补缺的）→ 基础字典 →
 * 第一次时创建超级管理员。账号密码默认 admin / 123456（Jimmy 要求，只限本机开发库 jim_admin_local，
 * 登录后请修改）；也可以用未提交的 BOOTSTRAP_USERNAME / BOOTSTRAP_PASSWORD 覆盖。
 * 参数：--migrate-only 只迁移；--menus-only 迁移后只补菜单（新生成了模块时用）。
 * --stage2-only 只执行租户目录与平台菜单两项迁移，可与上述参数组合。
 */
async function bootstrapLocal(): Promise<void> {
  process.loadEnvFile();
  const env = validateEnv(process.env);
  if (
    env.NODE_ENV !== NodeEnv.Development ||
    env.OPENAPI_EXPORT ||
    !['localhost', '127.0.0.1', '::1'].includes(env.DB_HOST) ||
    env.DB_NAME !== 'jim_admin_local'
  )
    throw new Error(
      '只允许在本机开发库 jim_admin_local 初始化，不能操作其他数据库',
    );
  const username = normalizeUsername(process.env.BOOTSTRAP_USERNAME || 'admin');
  const password = process.env.BOOTSTRAP_PASSWORD || '123456';
  if (
    !process.argv.includes('--migrate-only') &&
    (!/^[a-z][a-z0-9_.-]{2,63}$/.test(username) ||
      !password ||
      passwordBytes(password) > PASSWORD_MAX_BYTES)
  )
    throw new Error(
      '初始化账号或密码不合法（BOOTSTRAP_USERNAME / BOOTSTRAP_PASSWORD）',
    );
  const migration = new DataSource({
    type: 'mysql',
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    timezone: 'Z',
    migrations: process.argv.includes('--stage2-only')
      ? [TenantCatalog1794412800000, PlatformMenus1794412800001]
      : [
          CreateFileAsset1793923200000,
          InitialSystem1793926800000,
          SystemRelationships1793930400000,
          FileAssetOrganization1793934000000,
          SystemLogs1793937600000,
          SystemFields1793941200000,
          CoreTables1793944800000,
          SharedDictionaries1794279600000,
          CodegenModuleSpec1794312000000,
          TenantCatalog1794412800000,
          PlatformMenus1794412800001,
          FormDefinition1794470400000,
          CodeRules1794528000000,
          DictionaryTags1794614400000,
          CommonCodeRuleStatus1794618000000,
          FormSubmission1794621600000,
          WorkflowDefinition1794625200000,
        ],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    logging: false,
  });
  applyUtcSessions(migration);
  await migration.initialize();
  try {
    await migration.runMigrations();
  } finally {
    await migration.destroy();
  }
  if (process.argv.includes('--migrate-only')) {
    console.log('本地版本化迁移完成，未创建或重置账号');
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    const context = app.get(RequestContext);
    const repos = app.get(TenantRepositoryFactory);
    const source = app.get(DataSource);
    const codes = new Set(
      app
        .get(PermissionRegistry)
        .all()
        .map((m) => m.code),
    );
    const generated = await loadGeneratedMenus(
      join(process.cwd(), 'src/modules'),
    );
    const menuOnly = process.argv.includes('--menus-only');
    const passwordHash = menuOnly ? '' : await PasswordHasher.hash(password);
    const report = await context.run({ tenantId: PLATFORM_TENANT_ID }, () =>
      source.transaction(async (manager) => {
        const menus = await seedMenus(manager, repos, codes, generated);
        const tenants = await app
          .get(TenantSeedService)
          .seed(manager, passwordHash, !menuOnly);
        if (menuOnly) return { menus, dicts: 0, admin: '跳过', tenants };
        const dicts = await context.run({ tenantId: PLATFORM_TENANT_ID }, () =>
          seedDicts(manager, repos),
        );
        const admin = await context.run({ tenantId: DEFAULT_TENANT_ID }, () =>
          seedAdmin(manager, repos, username, passwordHash),
        );
        return { menus, dicts, admin, tenants };
      }),
    );
    await app.get(PermissionService).bumpVersion(DEFAULT_TENANT_ID);
    await app.get(PermissionService).bumpVersion(PLATFORM_TENANT_ID);
    if (report.tenants.demo)
      await app.get(PermissionService).bumpVersion(report.tenants.demo);
    console.log(
      `本地初始化完成：菜单新增 ${report.menus.added} 个（已有 ${report.menus.kept} 个，` +
        `权限码未声明而跳过 ${report.menus.skipped.length} 个${report.menus.skipped.length ? '：' + report.menus.skipped.join('、') : ''}）；` +
        `字典新增 ${report.dicts} 项；管理员：${report.admin}`,
    );
  } finally {
    await app.close();
  }
}

type Repos = TenantRepositoryFactory;

/**
 * 菜单：目录按路径、页面按路径、按钮按「上级 + 权限码」判断是否已有，只补缺的，不改已有菜单
 * （管理员可能已经调整过名称、排序、图标）。权限码没在后端声明的页面跳过。
 */
async function seedMenus(
  manager: EntityManager,
  repos: Repos,
  codes: Set<string>,
  generated: { file: string; menu: GeneratedMenu }[],
): Promise<{ added: number; kept: number; skipped: string[] }> {
  const repo = repos.for(SystemMenu);
  const rows = await repo.query('m', manager).getMany();
  const byPath = new Map(
    rows.filter((r) => r.type !== 'button').map((r) => [r.path, r]),
  );
  const buttons = new Set(
    rows
      .filter((r) => r.type === 'button')
      .map((r) => `${r.parentId}|${r.permission}`),
  );
  const stats = { added: 0, kept: 0, skipped: [] as string[] };

  const node = async (
    values: Partial<SystemMenu> & Pick<SystemMenu, 'type' | 'path' | 'title'>,
  ): Promise<string> => {
    const hit = byPath.get(values.path);
    if (hit) {
      stats.kept++;
      return hit.id;
    }
    const id = await repo.insert(
      {
        icon: null,
        component: null,
        permission: null,
        keepAlive: false,
        hidden: false,
        rank: 0,
        parentId: null,
        scope: 'tenant',
        ...values,
      },
      manager,
    );
    byPath.set(values.path, { ...values, id } as SystemMenu);
    stats.added++;
    return id;
  };
  const button = async (
    parentId: string,
    code: string,
    title: string,
    scope: 'platform' | 'tenant' = 'tenant',
  ) => {
    const key = `${parentId}|${code}`;
    if (buttons.has(key)) {
      stats.kept++;
      return;
    }
    await repo.insert(
      {
        parentId,
        scope,
        type: 'button',
        path: '',
        title,
        icon: null,
        rank: 0,
        component: null,
        permission: code,
        keepAlive: false,
        hidden: false,
      },
      manager,
    );
    buttons.add(key);
    stats.added++;
  };

  let dirRank = 0;
  for (const dir of DEFAULT_MENUS) {
    dirRank += 10;
    const pages = dir.pages.filter((p) => {
      if (codes.has(p.permission)) return true;
      stats.skipped.push(p.title);
      return false;
    });
    if (!pages.length) continue;
    const dirId = await node({
      type: 'directory',
      path: dir.path,
      title: dir.title,
      icon: dir.icon ?? null,
      rank: dirRank,
      scope: dir.scope ?? 'tenant',
    });
    let rank = 0;
    for (const p of pages) {
      rank += 10;
      const pageId = await node({
        parentId: dirId,
        type: 'page',
        path: p.path,
        title: p.title,
        icon: p.icon ?? null,
        rank,
        component: p.component,
        hidden: p.hidden ?? false,
        permission: p.permission,
        scope: p.scope ?? dir.scope ?? 'tenant',
      });
      const own = [...codes]
        .filter(
          (c) =>
            c !== p.permission &&
            p.buttonPrefixes.some((pre) => c.startsWith(`${pre}:`)),
        )
        .sort();
      for (const c of own)
        await button(
          pageId,
          c,
          buttonTitle(c),
          p.scope ?? dir.scope ?? 'tenant',
        );
    }
  }

  // 代码生成器生成的模块：放在「业务模块」目录下
  const usable = generated.filter(({ menu }) => {
    if (codes.has(menu.page.permission)) return true;
    stats.skipped.push(menu.page.title);
    return false;
  });
  if (usable.length) {
    const bizId = await node({
      type: 'directory',
      path: '/business',
      title: '业务模块',
      icon: 'ri:apps-line',
      rank: 5,
    });
    let rank = 0;
    for (const { menu } of usable) {
      rank += 10;
      const pageId = await node({
        parentId: bizId,
        type: 'page',
        path: menu.page.path,
        title: menu.page.title,
        rank,
        component: menu.page.component,
        permission: menu.page.permission,
      });
      for (const b of menu.buttons)
        if (codes.has(b.permission))
          await button(pageId, b.permission, b.title);
    }
  }
  return stats;
}

/** 基础字典：通用状态、是否。已有同编码的字典就不动 */
async function seedDicts(
  manager: EntityManager,
  repos: Repos,
): Promise<number> {
  const seeds: { code: string; name: string; items: [string, string][] }[] = [
    {
      code: 'sys.common_status',
      name: '通用状态',
      items: [
        ['1', '启用'],
        ['0', '停用'],
      ],
    },
    {
      code: 'sys.yes_no',
      name: '是否',
      items: [
        ['1', '是'],
        ['0', '否'],
      ],
    },
  ];
  let added = 0;
  for (const d of seeds) {
    const hit = await repos
      .for(SystemDictType)
      .query('t', manager)
      .where('t.code = :code', { code: d.code })
      .getOne();
    if (hit) continue;
    const typeId = await repos
      .for(SystemDictType)
      .insert(
        { code: d.code, name: d.name, enabled: true, builtin: true, rank: 0 },
        manager,
      );
    let rank = 0;
    for (const [value, label] of d.items) {
      rank += 10;
      await repos
        .for(SystemDictItem)
        .insert({ typeId, value, label, enabled: true, rank }, manager);
      added++;
    }
  }
  return added;
}

/** 超级管理员：库里还没有任何用户时才创建；已有用户就跳过，不改任何账号的密码或权限 */
async function seedAdmin(
  manager: EntityManager,
  repos: Repos,
  username: string,
  passwordHash: string,
): Promise<string> {
  if (await repos.for(SystemUser).query('u', manager).getCount())
    return '已有用户，未创建、未改密码';
  const orgId = await repos
    .for(SystemOrg)
    .insert(
      { name: '默认组织', parentId: null, enabled: true, rank: 0 },
      manager,
    );
  const roleId = await repos.for(SystemRole).insert(
    {
      code: 'superadmin',
      name: '超级管理员',
      enabled: true,
      allPermissions: true,
      permissions: [],
      dataScope: 'all',
      customOrgIds: [],
    },
    manager,
  );
  const userId = await repos.for(SystemUser).insert(
    {
      username,
      passwordHash,
      nickname: '管理员',
      avatar: null,
      enabled: true,
      locale: 'zh-CN',
      defaultOrgId: orgId,
    },
    manager,
  );
  await repos
    .for(SystemUserRole)
    .insert({ userId, roleId, scopeOrgId: orgId }, manager);
  return `已创建 ${username}（初始密码见说明，登录后请修改）`;
}
await bootstrapLocal();
