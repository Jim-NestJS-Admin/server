import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { CrudRuntime } from '../../../core/crud/crud.runtime.js';
import type { CrudDictionarySource } from '../../../core/crud/crud-dictionary.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { PLATFORM_TENANT_ID } from '../../../core/tenant/tenant.constants.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { PermissionService } from '../../../core/permission/permission.service.js';
import { RedisService } from '../../../core/redis/redis.service.js';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../core/exceptions/error-code.js';
import { SystemDictType, SystemDictItem } from '../entity/system-log.entity.js';

/** 仅为共享字典提供平台上下文，绝不接受请求传入的租户编号。 */
@Injectable()
export class SystemDictionaryService
  implements CrudDictionarySource, OnModuleInit
{
  constructor(
    private readonly context: RequestContext,
    private readonly repos: TenantRepositoryFactory,
    private readonly permission: PermissionService,
    private readonly redis: RedisService,
    private readonly runtime: CrudRuntime,
  ) {}
  onModuleInit() {
    this.runtime.dictionary = this;
  }
  tenant() {
    return this.context.current().tenantId;
  }
  /** 开发生成器只读目录；业务字典限定当前租户，系统字典经共享上下文读取。 */
  async catalog() {
    const load = async (builtin: boolean) =>
      (
        await this.repos
          .for(SystemDictType)
          .query('t')
          .where('t.builtin = :builtin AND t.enabled = :enabled', {
            builtin,
            enabled: true,
          })
          .orderBy('t.code', 'ASC')
          .getMany()
      ).map((t) => ({ code: t.code, label: t.name, builtin: t.builtin }));
    return [...(await this.platform(() => load(true))), ...(await load(false))];
  }
  async assertSystemManager(): Promise<void> {
    // 阶段 2（契约 tenant.md 第 9 节）：系统字典所有租户共用，只有平台超级管理员能改；租户超管只读
    if (
      this.context.current().tenantId !== PLATFORM_TENANT_ID ||
      !(await this.permission.isSuperAdmin())
    )
      throw new BusinessException(
        ErrorCode.Forbidden,
        '只有平台超级管理员能维护系统字典',
        403,
      );
  }
  async platform<R>(fn: () => Promise<R>): Promise<R> {
    const actor = this.context.current();
    return this.context.run(
      { tenantId: PLATFORM_TENANT_ID, userId: actor.userId, orgId: null },
      fn,
    );
  }
  async owner(id: string, item: boolean): Promise<string> {
    const own = item
      ? await this.repos
          .for(SystemDictItem)
          .query('d')
          .where('d.id = :id', { id })
          .getOne()
      : await this.repos
          .for(SystemDictType)
          .query('d')
          .where('d.id = :id', { id })
          .getOne();
    if (own) {
      const builtin = item
        ? (await this.type((own as SystemDictItem).typeId)).builtin
        : (own as SystemDictType).builtin;
      if (builtin) await this.assertSystemManager();
      return this.tenant();
    }
    if (!(await this.permission.isSuperAdmin())) throw crudErrors.notFound();
    const shared = await this.platform(async () => {
      const typeId = item
        ? (
            await this.repos
              .for(SystemDictItem)
              .query('i')
              .where('i.id = :id', { id })
              .getOne()
          )?.typeId
        : id;
      if (!typeId) return null;
      return this.repos
        .for(SystemDictType)
        .query('t')
        .where('t.id = :id AND t.builtin = :builtin', {
          id: typeId,
          builtin: true,
        })
        .getOne();
    });
    if (!shared) throw crudErrors.notFound();
    return PLATFORM_TENANT_ID;
  }
  async inOwner<R>(owner: string, fn: () => Promise<R>): Promise<R> {
    if (owner === this.tenant()) return fn();
    await this.assertSystemManager();
    return this.platform(fn);
  }
  async type(id: string, manager?: EntityManager): Promise<SystemDictType> {
    const row = await this.repos
      .for(SystemDictType)
      .query('t', manager)
      .where('t.id = :id', { id })
      .getOne();
    if (!row) throw crudErrors.notFound();
    return row;
  }
  async touch(typeId: string, manager: EntityManager): Promise<void> {
    // 类型版本随项目变更在同一个事务里递增；所有租户的缓存键都会切到新版本，Redis失效失败也不会继续读旧项。
    await this.repos.for(SystemDictType).update([typeId], {}, manager);
  }
  async options(
    code: string,
    manager?: EntityManager,
  ): Promise<{ value: string; label: string }[]> {
    const requester = this.tenant();
    const shared = code.startsWith('sys.');
    const load = async () => {
      const type = await this.repos
        .for(SystemDictType)
        .query('t', manager)
        .where('t.code = :code AND t.builtin = :builtin', {
          code,
          builtin: shared,
        })
        .getOne();
      if (!type?.enabled) return [];
      const key = this.redis.tenantKey(
        requester,
        'dictionary',
        type.id,
        `v${type.version}`,
      );
      if (!manager) {
        const hit = await this.redis.call((r) => r.get(key));
        if (hit) return JSON.parse(hit) as { value: string; label: string }[];
      }
      const rows = await this.repos
        .for(SystemDictItem)
        .query('i', manager)
        .where('i.typeId = :id AND i.enabled = :enabled', {
          id: type.id,
          enabled: true,
        })
        .orderBy('i.rank', 'ASC')
        .addOrderBy('i.id', 'ASC')
        .getMany();
      const items = rows.map((row) => ({ value: row.value, label: row.label }));
      if (!manager)
        await this.redis.call((r) =>
          r.set(key, JSON.stringify(items), 'EX', 300),
        );
      return items;
    };
    return shared ? this.platform(load) : load();
  }
}
