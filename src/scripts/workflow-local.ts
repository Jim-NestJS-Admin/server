import 'reflect-metadata';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateEnv, NodeEnv } from '../core/config/env.validation.js';

/** 仅供明确授权后的本机联调配置；默认只输出计划，不连库、不执行迁移、不建账号或审批。 */
export async function workflowLocal(apply: boolean) {
  const plan = {
    database: 'jim_admin_local',
    menus: ['流程管理', '审批工作台'],
    package: 'all（仅default使用时）',
    codeRule: 'workflow_definition_default',
    format: 'wf_000001',
    businessWrites: false,
  };
  if (!apply) {
    console.log(JSON.stringify({ apply: false, plan }, null, 2));
    return;
  }
  process.loadEnvFile();
  const env = validateEnv(process.env);
  if (
    env.NODE_ENV !== NodeEnv.Development ||
    env.DB_NAME !== 'jim_admin_local' ||
    env.DB_SYNCHRONIZE ||
    !['localhost', '127.0.0.1', '::1'].includes(env.DB_HOST)
  )
    throw Error('只允许本机jim_admin_local且禁止synchronize');
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module.js');
  const { DataSource } = await import('typeorm');
  const { RequestContext } = await import('../core/tenant/request-context.js');
  const { TenantRepositoryFactory } =
    await import('../core/tenant/tenant-repository.js');
  const { PermissionService } =
    await import('../core/permission/permission.service.js');
  const { SystemOperationRecorder } =
    await import('../modules/system-log/service/system-audit.service.js');
  const { SystemMenu } =
    await import('../modules/system/entity/system.entity.js');
  const { SystemTenant, TenantPackage } =
    await import('../modules/tenant/entity/tenant.entity.js');
  const { CodeRule, CodeBinding } =
    await import('../modules/code-rule/entity/code-rule.entity.js');
  const { CodeRuleService } =
    await import('../modules/code-rule/service/code-rule.service.js');
  const { DEFAULT_MENUS, buttonTitle } =
    await import('../database/seeds/menus.js');
  const document = JSON.parse(
    await readFile(resolve('openapi/admin.json'), 'utf8'),
  ) as {
    paths: Record<
      string,
      Record<string, { 'x-permission'?: { code: string } }>
    >;
  };
  const codes = [
    ...new Set(
      Object.values(document.paths).flatMap((p) =>
        Object.values(p).flatMap((op) =>
          op['x-permission']?.code ? [op['x-permission'].code] : [],
        ),
      ),
    ),
  ];
  const pages = DEFAULT_MENUS.find(
    (dir) => dir.path === '/forms',
  )!.pages.filter((p) => p.component.startsWith('workflow/'));
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    const db = app.get(DataSource),
      ctx = app.get(RequestContext),
      repos = app.get(TenantRepositoryFactory),
      audit = app.get(SystemOperationRecorder);
    const result = await ctx.run({ tenantId: '0' }, () =>
      db.transaction(async (manager) => {
        const pack = await repos
          .for(TenantPackage)
          .query('p', manager)
          .andWhere('p.code = :code', { code: 'all' })
          .setLock('pessimistic_write')
          .getOne();
        if (!pack) throw Error('找不到all套餐');
        const tenants = await repos
          .for(SystemTenant)
          .query('t', manager)
          .andWhere('t.packageId = :id', { id: pack.id })
          .setLock('pessimistic_read')
          .getMany();
        if (tenants.length !== 1 || tenants[0]!.code !== 'default')
          throw Error('all套餐不再仅default使用，拒绝扩大其他租户权限');
        const menuRepo = repos.for(SystemMenu),
          menus = await menuRepo
            .query('m', manager)
            .setLock('pessimistic_write')
            .getMany();
        const parent = menus.find((m) => m.path === '/forms');
        if (!parent) throw Error('缺少表单与流程目录');
        const ids = [parent.id],
          added: string[] = [];
        const backup = resolve(
          'logs',
          `workflow-local-before-${Date.now()}.json`,
        );
        await mkdir(resolve('logs'), { recursive: true });
        await writeFile(
          backup,
          JSON.stringify({ menus, package: pack }, null, 2),
        );
        for (const [index, page] of pages.entries()) {
          let row = menus.find((m) => m.path === page.path);
          if (
            row &&
            (row.component !== page.component ||
              row.permission !== page.permission)
          )
            throw Error(`已有菜单${page.path}配置不同，拒绝覆盖`);
          const pageId =
            row?.id ??
            (await menuRepo.insert(
              {
                parentId: parent.id,
                title: page.title,
                type: 'page',
                path: page.path,
                component: page.component,
                permission: page.permission,
                scope: 'tenant',
                icon: null,
                rank: 30 + index * 10,
                hidden: false,
                keepAlive: false,
              },
              manager,
            ));
          if (!row) added.push(page.title);
          ids.push(pageId);
          const permissions = codes.filter(
            (c) =>
              c !== page.permission &&
              (page.buttonPrefixes.some((pre) => c.startsWith(pre + ':')) ||
                page.buttonPermissions?.includes(c)),
          );
          for (const code of permissions) {
            const existing = menus.find(
              (m) =>
                m.type === 'button' &&
                m.parentId === pageId &&
                m.permission === code,
            );
            const id =
              existing?.id ??
              (await menuRepo.insert(
                {
                  parentId: pageId,
                  title: buttonTitle(code),
                  type: 'button',
                  path: '',
                  component: null,
                  permission: code,
                  scope: 'tenant',
                  icon: null,
                  rank: 0,
                  hidden: false,
                  keepAlive: false,
                },
                manager,
              ));
            ids.push(id);
          }
        }
        const menuIds = [...new Set([...pack.menuIds, ...ids])];
        if (menuIds.length !== pack.menuIds.length)
          await repos
            .for(TenantPackage)
            .update([pack.id], { menuIds }, manager);
        await audit.configuration(
          manager,
          'workflow.local.configure',
          'workflow/menus',
          { packageId: pack.id, menuIds: pack.menuIds },
          { packageId: pack.id, menuIds, added },
        );
        return {
          tenantId: tenants[0]!.id,
          packageId: pack.id,
          added,
          menuIds: ids,
          backup,
        };
      }),
    );
    await app.get(PermissionService).bumpVersion(result.tenantId);
    const binding = await ctx.run({ tenantId: result.tenantId }, async () => {
      const current = await repos
        .for(CodeBinding)
        .query('b')
        .andWhere('b.usageKey = :key', { key: 'workflow_definition_code' })
        .getOne();
      if (current) return { kept: true, ruleId: current.ruleId };
      let row = await repos
        .for(CodeRule)
        .query('r')
        .andWhere('r.code = :code', { code: 'workflow_definition_default' })
        .getOne();
      const config = {
        code: 'workflow_definition_default',
        name: '流程定义默认编码',
        description: '本机审批联调初始化；管理员可在编码规则中查看和维护',
        timezone: 'Asia/Shanghai',
        resetPeriod: 'never',
        start: '1',
        status: '1',
        segments: [
          { type: 'literal' as const, value: 'wf_' },
          { type: 'sequence' as const, width: 6 },
        ],
      };
      if (row) {
        for (const key of [
          'timezone',
          'resetPeriod',
          'start',
          'status',
          'segments',
        ] as const)
          if (JSON.stringify(row[key]) !== JSON.stringify(config[key]))
            throw Error('同名编码规则已有其他配置，拒绝覆盖');
      } else {
        const created = await app.get(CodeRuleService).add(config);
        row = await repos
          .for(CodeRule)
          .query('r')
          .andWhere('r.id = :id', { id: created.id })
          .getOne();
      }
      if (!row) throw Error('默认编码规则创建失败');
      await app.get(CodeRuleService).bind('workflow_definition_code', row.id);
      return { kept: false, ruleId: row.id };
    });
    console.log(
      JSON.stringify({
        configured: true,
        ...result,
        binding,
        format: plan.format,
        createdApplications: 0,
        createdAccounts: 0,
      }),
    );
  } finally {
    await app.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await workflowLocal(process.argv.includes('--apply'));
