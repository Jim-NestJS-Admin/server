import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { crudErrors } from '../crud/crud.errors.js';
import { CrudRuntime } from '../crud/crud.runtime.js';
import type { CrudResourceMeta } from '../crud/crud.types.js';
import { PermissionService } from '../permission/permission.service.js';
import { TenantRepositoryFactory } from '../tenant/tenant-repository.js';
import { RequestContext } from '../tenant/request-context.js';
import { UserPreferenceEntity } from '../preference/user-preference.entity.js';
import {
  PageConfigEntity,
  PageConfigHistoryEntity,
} from './page-config.entity.js';
import {
  validatePageConfig,
  type PageConfig,
  type ViewColumn,
} from './page-config.rules.js';

/** 页面描述合并生效配置要的三样东西（BaseController.schema 用） */
export abstract class PageViewSource {
  abstract load(meta: CrudResourceMeta): Promise<{
    admin: PageConfig | null;
    user: { columns?: ViewColumn[] } | null;
    canWrite: boolean;
  }>;
}

/**
 * 在线页面配置（T23）：管理员的模块显示配置读写、历史、恢复、重置；给页面描述提供三层合并的输入。
 * 只管显示，安全配置（字段权限）在 T17 的 sys_field / sys_role_field。
 */
@Injectable()
export class PageConfigService extends PageViewSource {
  private readonly logger = new Logger('PageConfig');

  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly crud: CrudRuntime,
    private readonly context: RequestContext,
    private readonly permissions: PermissionService,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  meta(resource: string): CrudResourceMeta {
    const m = this.crud.list().find((r) => r.permPrefix === resource);
    if (!m) throw crudErrors.notFound();
    return m;
  }

  private current(resource: string) {
    return this.repos
      .for(PageConfigEntity)
      .query('c')
      .andWhere('c.resource = :r', { r: resource })
      .getOne();
  }

  async get(resource: string) {
    this.meta(resource);
    const row = await this.current(resource);
    return {
      resource,
      version: row?.version ?? 0,
      config: (row?.config as PageConfig | undefined) ?? null,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /** 保存（version 是读到的版本，没配置过时是 0）；旧内容进历史 */
  async save(resource: string, version: number, config: unknown) {
    const meta = this.meta(resource);
    if (config !== null) {
      const errors = validatePageConfig(meta, config);
      if (errors.length) throw crudErrors.badRequest('配置不合法', errors);
    }
    await this.dataSource.transaction(async (manager) => {
      const repo = this.repos.for(PageConfigEntity);
      const row = await repo
        .query('c', manager)
        .andWhere('c.resource = :r', { r: resource })
        .setLock('pessimistic_write')
        .getOne();
      if ((row?.version ?? 0) !== version) throw crudErrors.versionConflict();
      await this.repos
        .for(PageConfigHistoryEntity)
        .insert(
          { resource, config: row?.config ?? null, configVersion: version },
          manager,
        );
      if (!row && config !== null)
        await repo.insert({ resource, config }, manager);
      else if (row && config !== null)
        await repo.update([row.id], { config }, manager);
      else if (row) await repo.remove([row.id], manager);
    });
    this.logger.log({
      event: 'page-config.saved',
      resource,
      version,
      reset: config === null,
    });
    return this.get(resource);
  }

  async history(resource: string, page: number, size: number) {
    this.meta(resource);
    const [rows, total] = await this.repos
      .for(PageConfigHistoryEntity)
      .query('h')
      .andWhere('h.resource = :r', { r: resource })
      .orderBy('h.id', 'DESC')
      .offset((page - 1) * size)
      .limit(size)
      .getManyAndCount();
    return {
      list: rows.map((h) => ({
        id: h.id,
        configVersion: h.configVersion,
        createdBy: h.createdBy,
        createdAt: h.createdAt,
      })),
      total,
      page,
      size,
    };
  }

  private async historyRow(resource: string, id: string) {
    const h = await this.repos
      .for(PageConfigHistoryEntity)
      .query('h')
      .andWhere('h.resource = :r AND h.id = :id', { r: resource, id })
      .getOne();
    if (!h) throw crudErrors.notFound();
    return h;
  }

  async historyInfo(resource: string, id: string) {
    const h = await this.historyRow(resource, id);
    return {
      id: h.id,
      configVersion: h.configVersion,
      config: h.config ?? null,
    };
  }

  /** 恢复历史版本：照样校验（字段可能已经变了，不合法的部分要管理员先改） */
  async restore(resource: string, historyId: string, version: number) {
    const h = await this.historyRow(resource, historyId);
    return this.save(resource, version, h.config ?? null);
  }

  async load(meta: CrudResourceMeta) {
    const { userId, orgId } = this.context.current();
    const admin = await this.current(meta.permPrefix);
    const pref = userId
      ? await this.repos
          .for(UserPreferenceEntity)
          .query('p')
          .andWhere('p.userId = :u AND p.scope = :s AND p.key = :k', {
            u: userId,
            s: orgId ?? '-',
            k: `columns:${meta.permPrefix}`,
          })
          .getOne()
      : null;
    let canWrite = false;
    try {
      const { codes } = await this.permissions.permissions();
      canWrite =
        codes.includes(`${meta.permPrefix}:add`) ||
        codes.includes(`${meta.permPrefix}:update`);
    } catch {
      canWrite = false;
    }
    const user = pref?.value as { columns?: ViewColumn[] } | undefined;
    return {
      admin: (admin?.config as PageConfig | undefined) ?? null,
      user:
        user && Array.isArray(user.columns) ? { columns: user.columns } : null,
      canWrite,
    };
  }
}
