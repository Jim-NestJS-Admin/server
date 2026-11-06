import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module.js';
import { validateEnv, NodeEnv } from '../core/config/env.validation.js';
import { SnakeNamingStrategy } from '../core/database/naming.strategy.js';
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
import {
  SystemOrg,
  SystemRole,
  SystemUser,
  SystemUserRole,
} from '../modules/system/entity/system.entity.js';

/** 本地一次性建号入口：凭据只来自未提交环境变量，不提供默认明文密码。 */
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
  const username = normalizeUsername(process.env.BOOTSTRAP_USERNAME ?? '');
  const password = process.env.BOOTSTRAP_PASSWORD ?? '';
  if (
    !process.argv.includes('--migrate-only') &&
    (!/^[a-z][a-z0-9_.-]{2,63}$/.test(username) ||
      !password ||
      passwordBytes(password) > PASSWORD_MAX_BYTES)
  )
    throw new Error('请通过本地环境变量提供合法初始化账号和符合密码规则的密码');
  const migration = new DataSource({
    type: 'mysql',
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    migrations: [
      InitialSystem1793926800000,
      SystemRelationships1793930400000,
      SystemLogs1793937600000,
      SystemFields1793941200000,
    ],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    logging: false,
  });
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
    const passwordHash = await PasswordHasher.hash(password);
    await context.run({ tenantId: DEFAULT_TENANT_ID }, () =>
      source.transaction(async (manager) => {
        const existing = await repos
          .for(SystemUser)
          .query('u', manager)
          .where('u.username = :username', { username })
          .getOne();
        if (existing)
          throw new Error('账号已存在，未覆盖密码或权限；请使用原账号登录');
        if (await repos.for(SystemUser).query('u', manager).getCount())
          throw new Error('数据库已有用户，拒绝再次初始化管理员');
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
      }),
    );
    await app.get(PermissionService).bumpVersion(DEFAULT_TENANT_ID);
    console.log(
      '本地管理员已初始化；账号和初始密码见未提交的本地配置，不在日志输出',
    );
  } finally {
    await app.close();
  }
}
await bootstrapLocal();
