import { Inject, Injectable } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { BaseEntity } from '../../../core/crud/base.entity.js';
import { BaseService, type CrudRow } from '../../../core/crud/base.service.js';
import type { CrudTx } from '../../../core/crud/crud.types.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { PermissionService } from '../../../core/permission/permission.service.js';
import { PermissionRegistry } from '../../../core/permission/permission-registry.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { SessionService } from '../../../core/auth/session.service.js';
import {
  PasswordHasher,
  checkPasswordPolicy,
  normalizeUsername,
} from '../../../core/auth/password.js';
import {
  SystemUser,
  SystemOrg,
  SystemRole,
  SystemUserRole,
  SystemMenu,
  SystemUserSupervisor,
} from '../entity/system.entity.js';
import type { CreateSystemUser } from '../dto/system.dto.js';
import { validOrganizations } from './organization-policy.js';

/** 公共管理资源的写入仍走BaseService，提交后才失效权限缓存。 */
export abstract class SystemCrudService<
  T extends BaseEntity,
> extends BaseService<T> {
  @Inject(TenantRepositoryFactory)
  protected readonly repos: TenantRepositoryFactory;
  @Inject(PermissionService) protected readonly permissions: PermissionService;
  @Inject(RequestContext) protected readonly context: RequestContext;
  protected override async transaction<R>(
    fn: (tx: CrudTx) => Promise<R>,
  ): Promise<R> {
    const result = await super.transaction(fn);
    await this.permissions.bumpVersion(this.context.current().tenantId);
    return result;
  }
  protected async reference<E extends BaseEntity>(
    entity: Type<E>,
    id: string,
    tx: CrudTx,
  ): Promise<E> {
    const row = await this.repos
      .for(entity)
      .query('r', tx.manager)
      .where('r.id = :id', { id })
      .getOne();
    if (!row) throw crudErrors.badRequest('关联数据不存在或不可使用');
    return row;
  }
  protected async org(id: string, tx: CrudTx): Promise<SystemOrg> {
    const rows = await this.repos
      .for(SystemOrg)
      .query('o', tx.manager)
      .getMany();
    const row = validOrganizations(rows).find((org) => org.id === id);
    if (!row) throw crudErrors.badRequest('组织不存在、已停用或上级组织无效');
    return row;
  }
}

@Injectable()
export class SystemUserService extends BaseService<SystemUser> {
  @Inject(TenantRepositoryFactory)
  private readonly repos: TenantRepositoryFactory;
  @Inject(SessionService) private readonly sessions: SessionService;
  @Inject(PermissionService) private readonly permissions: PermissionService;
  @Inject(RequestContext) private readonly context: RequestContext;

  private password(password: string, username: string): void {
    const errors = checkPasswordPolicy(password, username);
    if (errors.length)
      throw crudErrors.badRequest('密码不符合要求', [
        { field: 'password', messages: errors },
      ]);
  }
  private async defaultOrg(
    id: string | null | undefined,
    tx: CrudTx,
  ): Promise<void> {
    if (!id) return;
    const orgs = await this.repos
      .for(SystemOrg)
      .query('o', tx.manager)
      .getMany();
    if (!validOrganizations(orgs).some((org) => org.id === id))
      throw crudErrors.badRequest('默认组织不存在或已停用');
  }
  async create(input: CreateSystemUser): Promise<{ id: string }> {
    const username = normalizeUsername(input.username);
    this.password(input.password, username);
    const passwordHash = await PasswordHasher.hash(input.password);
    return this.transaction(async (tx) => {
      await this.defaultOrg(input.defaultOrgId, tx);
      const id = await this.insertRow(tx, {
        username,
        passwordHash,
        nickname: input.nickname,
        enabled: input.enabled ?? true,
        defaultOrgId: input.defaultOrgId ?? null,
        avatar: null,
        locale: 'zh-CN',
      });
      return { id };
    });
  }
  protected override async beforeUpdate(
    changes: Partial<SystemUser>,
    existing: SystemUser,
    tx: CrudTx,
  ): Promise<void> {
    if (existing.id === tx.ctx.userId && changes.enabled === false)
      throw crudErrors.badRequest('不能停用当前登录账号');
    await this.defaultOrg(changes.defaultOrgId, tx);
  }
  override async update(
    id: string,
    version: number,
    changes: Partial<SystemUser>,
    children?: unknown,
  ): Promise<CrudRow<SystemUser>> {
    const result = await super.update(id, version, changes, children);
    if (changes.enabled !== undefined)
      await Promise.all([
        this.sessions.revokeUser(this.context.current().tenantId, id),
        this.permissions.bumpVersion(this.context.current().tenantId),
      ]);
    return result;
  }
  protected override async beforeDelete(
    rows: SystemUser[],
    tx: CrudTx,
  ): Promise<void> {
    if (rows.some((row) => row.id === tx.ctx.userId))
      throw crudErrors.badRequest('不能删除当前登录账号');
    const ids = rows.map((row) => row.id);
    const assigned = await this.repos
      .for(SystemUserRole)
      .query('g', tx.manager)
      .where('g.userId IN (:...ids)', { ids })
      .getCount();
    const supervisors = await this.repos
      .for(SystemUserSupervisor)
      .query('s', tx.manager)
      .where('s.userId IN (:...ids) OR s.supervisorId IN (:...ids)', { ids })
      .getCount();
    if (assigned || supervisors)
      throw crudErrors.badRequest('请先解除用户的角色分配和上下级关系');
  }
  override async delete(ids: string[]): Promise<{ count: number }> {
    const result = await super.delete(ids);
    const tenantId = this.context.current().tenantId;
    await Promise.all([
      this.permissions.bumpVersion(tenantId),
      ...ids.map((id) => this.sessions.revokeUser(tenantId, id)),
    ]);
    return result;
  }
  async setPassword(
    id: string,
    version: number,
    password: string,
    oldPassword?: string,
  ): Promise<{ id: string }> {
    await this.transaction(async (tx) => {
      const user = await this.select(tx.manager, 'update')
        .addSelect('e.passwordHash')
        .andWhere('e.id = :id', { id })
        .setLock('pessimistic_write')
        .getOne();
      if (!user) throw crudErrors.notFound();
      if (user.version !== version) throw crudErrors.versionConflict();
      if (
        oldPassword !== undefined &&
        !(await PasswordHasher.verify(oldPassword, user.passwordHash))
      )
        throw crudErrors.badRequest('原密码不正确');
      this.password(password, user.username);
      await this.repos
        .for(SystemUser)
        .update(
          [id],
          { passwordHash: await PasswordHasher.hash(password) },
          tx.manager,
        );
    });
    await this.sessions.revokeUser(this.context.current().tenantId, id);
    return { id };
  }
}

@Injectable()
export class SystemRoleService extends SystemCrudService<SystemRole> {
  @Inject(PermissionRegistry) private readonly registry: PermissionRegistry;
  private async validateRole(
    data: Partial<SystemRole>,
    tx: CrudTx,
  ): Promise<void> {
    if (data.permissions) {
      const current = new Set((await this.permissions.permissions()).codes);
      if (
        data.permissions.some(
          (code) => !this.registry.get(code) || !current.has(code),
        )
      )
        throw crudErrors.badRequest('权限码不存在或超出当前可授予范围');
    }
    for (const id of data.customOrgIds ?? []) await this.org(id, tx);
    if (data.dataScope === 'custom' && !data.customOrgIds?.length)
      throw crudErrors.badRequest('自定义数据范围至少选择一个组织');
  }
  protected override async beforeAdd(
    data: Partial<SystemRole>,
    tx: CrudTx,
  ): Promise<void> {
    await this.validateRole(data, tx);
  }
  protected override async beforeUpdate(
    data: Partial<SystemRole>,
    row: SystemRole,
    tx: CrudTx,
  ): Promise<void> {
    if (
      row.allPermissions &&
      (data.enabled === false ||
        (data.dataScope !== undefined && data.dataScope !== 'all'))
    )
      throw crudErrors.badRequest('内置超级管理员角色不能停用或缩减数据范围');
    await this.validateRole(Object.assign({}, row, data), tx);
  }
  protected override async beforeDelete(
    rows: SystemRole[],
    tx: CrudTx,
  ): Promise<void> {
    if (rows.some((row) => row.allPermissions))
      throw crudErrors.badRequest('内置超级管理员角色不能删除');
    if (
      await this.repos
        .for(SystemUserRole)
        .query('g', tx.manager)
        .where('g.roleId IN (:...ids)', { ids: rows.map((row) => row.id) })
        .getCount()
    )
      throw crudErrors.badRequest('角色仍在使用，请先解除分配');
  }
}

@Injectable()
export class SystemOrgService extends SystemCrudService<SystemOrg> {
  private async validateTree(
    data: Partial<SystemOrg>,
    row: SystemOrg | undefined,
    tx: CrudTx,
  ): Promise<void> {
    // 同一租户的树变更先锁定现有节点，避免并发互相移动形成环。
    const rows = await this.repos
      .for(SystemOrg)
      .query('o', tx.manager)
      .orderBy('o.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    const parentId =
      data.parentId === undefined ? row?.parentId : data.parentId;
    if (!parentId) return;
    const valid = validOrganizations(rows);
    if (!valid.some((org) => org.id === parentId))
      throw crudErrors.badRequest('上级组织不存在或已停用');
    const map = new Map(rows.map((org) => [org.id, org]));
    const seen = new Set(row ? [row.id] : []);
    let current: SystemOrg | undefined = map.get(parentId);
    while (current) {
      if (seen.has(current.id))
        throw crudErrors.badRequest('组织不能移动到自己或下级组织');
      seen.add(current.id);
      current = current.parentId ? map.get(current.parentId) : undefined;
    }
  }
  protected override async beforeAdd(
    data: Partial<SystemOrg>,
    tx: CrudTx,
  ): Promise<void> {
    await this.validateTree(data, undefined, tx);
  }
  protected override async beforeUpdate(
    data: Partial<SystemOrg>,
    row: SystemOrg,
    tx: CrudTx,
  ): Promise<void> {
    await this.validateTree(data, row, tx);
  }
  protected override async beforeDelete(
    rows: SystemOrg[],
    tx: CrudTx,
  ): Promise<void> {
    const ids = rows.map((row) => row.id);
    if (
      await this.repos
        .for(SystemOrg)
        .query('o', tx.manager)
        .where('o.parentId IN (:...ids)', { ids })
        .getCount()
    )
      throw crudErrors.badRequest('组织仍有下级，不能删除');
    if (
      await this.repos
        .for(SystemUserRole)
        .query('g', tx.manager)
        .where('g.scopeOrgId IN (:...ids)', { ids })
        .getCount()
    )
      throw crudErrors.badRequest('组织仍有角色成员，不能删除');
    if (
      await this.repos
        .for(SystemUser)
        .query('u', tx.manager)
        .where('u.defaultOrgId IN (:...ids)', { ids })
        .getCount()
    )
      throw crudErrors.badRequest('组织仍是用户默认组织，不能删除');
  }
}

@Injectable()
export class SystemUserRoleService extends SystemCrudService<SystemUserRole> {
  private async validateGrant(
    data: Partial<SystemUserRole>,
    tx: CrudTx,
  ): Promise<void> {
    const user = await this.reference(SystemUser, data.userId!, tx);
    const role = await this.reference(SystemRole, data.roleId!, tx);
    if (!user.enabled || !role.enabled)
      throw crudErrors.badRequest('用户或角色已停用');
    if (role.allPermissions)
      throw crudErrors.badRequest('内置超级管理员分配只能通过初始化维护');
    if (data.scopeOrgId) await this.org(data.scopeOrgId, tx);
    const current = new Set((await this.permissions.permissions()).codes);
    if (role.permissions.some((code) => !current.has(code)))
      throw crudErrors.badRequest('角色超出当前可授予的权限范围');
    const query = this.repos
      .for(SystemUserRole)
      .query('g', tx.manager)
      .where('g.userId = :user AND g.roleId = :role', {
        user: data.userId,
        role: data.roleId,
      });
    if (data.scopeOrgId)
      query.andWhere('g.scopeOrgId = :scope', { scope: data.scopeOrgId });
    else query.andWhere('g.scopeOrgId IS NULL');
    if (data.id) query.andWhere('g.id <> :id', { id: data.id });
    if (await query.getCount())
      throw crudErrors.badRequest('此组织作用范围内已分配该角色');
  }
  protected override async beforeAdd(
    data: Partial<SystemUserRole>,
    tx: CrudTx,
  ): Promise<void> {
    await this.validateGrant(data, tx);
  }
  protected override async beforeUpdate(
    data: Partial<SystemUserRole>,
    row: SystemUserRole,
    tx: CrudTx,
  ): Promise<void> {
    const role = await this.reference(SystemRole, row.roleId, tx);
    if (role.allPermissions)
      throw crudErrors.badRequest('不能修改内置超级管理员分配');
    await this.validateGrant(Object.assign({}, row, data), tx);
  }
  protected override async beforeDelete(
    rows: SystemUserRole[],
    tx: CrudTx,
  ): Promise<void> {
    for (const row of rows)
      if ((await this.reference(SystemRole, row.roleId, tx)).allPermissions)
        throw crudErrors.badRequest('不能删除内置超级管理员分配');
  }
}

@Injectable()
export class SystemMenuService extends SystemCrudService<SystemMenu> {
  @Inject(PermissionRegistry) private readonly registry: PermissionRegistry;
  private async validateMenu(
    data: Partial<SystemMenu>,
    tx: CrudTx,
  ): Promise<void> {
    const rows = await this.repos
      .for(SystemMenu)
      .query('m', tx.manager)
      .orderBy('m.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    const map = new Map(rows.map((row) => [row.id, row]));
    if (data.permission && !this.registry.get(data.permission))
      throw crudErrors.badRequest('菜单权限码未由后端声明');
    if (data.type === 'page' && (!data.component || !data.path))
      throw crudErrors.badRequest('页面菜单必须填写组件和路径');
    if (data.type === 'button' && !data.permission)
      throw crudErrors.badRequest('按钮必须填写权限码');
    if (data.type !== 'button' && !data.path)
      throw crudErrors.badRequest('目录和页面必须填写路径');
    if (
      data.type !== 'button' &&
      rows.some(
        (row) =>
          row.id !== data.id && row.type !== 'button' && row.path === data.path,
      )
    )
      throw crudErrors.badRequest('菜单路径已存在');
    const seen = new Set(data.id ? [data.id] : []);
    let current = data.parentId ? map.get(data.parentId) : undefined;
    if (data.parentId && (!current || current.type === 'button'))
      throw crudErrors.badRequest('上级菜单不存在或为按钮');
    while (current) {
      if (seen.has(current.id))
        throw crudErrors.badRequest('菜单不能挂到自身或下级');
      seen.add(current.id);
      current = current.parentId ? map.get(current.parentId) : undefined;
    }
  }
  protected override async beforeAdd(
    data: Partial<SystemMenu>,
    tx: CrudTx,
  ): Promise<void> {
    await this.validateMenu(data, tx);
  }
  protected override async beforeUpdate(
    data: Partial<SystemMenu>,
    row: SystemMenu,
    tx: CrudTx,
  ): Promise<void> {
    await this.validateMenu(Object.assign({}, row, data), tx);
  }
  protected override async beforeDelete(
    rows: SystemMenu[],
    tx: CrudTx,
  ): Promise<void> {
    if (
      await this.repos
        .for(SystemMenu)
        .query('m', tx.manager)
        .where('m.parentId IN (:...ids)', { ids: rows.map((row) => row.id) })
        .getCount()
    )
      throw crudErrors.badRequest('请先删除下级菜单');
  }
}

@Injectable()
export class SystemSupervisorService extends SystemCrudService<SystemUserSupervisor> {
  private async validateLink(
    data: Partial<SystemUserSupervisor>,
    tx: CrudTx,
  ): Promise<void> {
    await this.reference(SystemUser, data.userId!, tx);
    await this.reference(SystemUser, data.supervisorId!, tx);
    const links = await this.repos
      .for(SystemUserSupervisor)
      .query('s', tx.manager)
      .orderBy('s.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    if (
      links.some(
        (link) =>
          link.id !== data.id &&
          link.userId === data.userId &&
          link.supervisorId === data.supervisorId,
      )
    )
      throw crudErrors.badRequest('该上下级关系已存在');
    const graph = new Map<string, string[]>();
    for (const link of links.filter((link) => link.id !== data.id))
      graph.set(link.userId, [
        ...(graph.get(link.userId) ?? []),
        link.supervisorId,
      ]);
    const stack = [data.supervisorId!],
      seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (id === data.userId)
        throw crudErrors.badRequest('上下级关系不能形成环');
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(graph.get(id) ?? []));
    }
  }
  protected override async beforeAdd(
    data: Partial<SystemUserSupervisor>,
    tx: CrudTx,
  ): Promise<void> {
    await this.validateLink(data, tx);
  }
  protected override async beforeUpdate(
    data: Partial<SystemUserSupervisor>,
    row: SystemUserSupervisor,
    tx: CrudTx,
  ): Promise<void> {
    await this.validateLink(Object.assign({}, row, data), tx);
  }
}
