import { Injectable } from '@nestjs/common';
import {
  AuthUserStore,
  type AuthProfile,
  type AuthUser,
} from '../../../core/auth/auth-user.store.js';
import { PermissionSource } from '../../../core/permission/permission-source.js';
import { SystemDirectory } from './system-directory.service.js';

@Injectable()
export class SystemAuthUserStore extends AuthUserStore {
  constructor(private readonly directory: SystemDirectory) {
    super();
  }
  async findForLogin(
    tenantId: string,
    username: string,
  ): Promise<AuthUser | null> {
    const user = await this.directory.user(tenantId, username);
    return user
      ? {
          id: user.id,
          passwordHash: user.passwordHash,
          enabled: user.enabled,
          defaultOrgId: user.defaultOrgId,
        }
      : null;
  }
  async findProfile(
    tenantId: string,
    userId: string,
  ): Promise<AuthProfile | null> {
    const user = await this.directory.profile(tenantId, userId);
    return user
      ? {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          avatar: user.avatar,
          enabled: user.enabled,
          locale: user.locale,
        }
      : null;
  }
  listOrgs(tenantId: string, userId: string) {
    return this.directory.userOrgs(tenantId, userId);
  }
}

@Injectable()
export class SystemPermissionSource extends PermissionSource {
  constructor(private readonly directory: SystemDirectory) {
    super();
  }
  loadGrants(tenantId: string, userId: string) {
    return this.directory.grants(tenantId, userId);
  }
  async loadOrgs(tenantId: string) {
    return (await this.directory.orgs(tenantId)).map((org) => ({
      id: org.id,
      parentId: org.parentId,
    }));
  }
  async loadMenus(tenantId: string) {
    return (await this.directory.menus(tenantId)).map((menu) => ({
      id: menu.id,
      parentId: menu.parentId,
      type: menu.type,
      path: menu.path,
      title: menu.title,
      icon: menu.icon,
      rank: menu.rank,
      component: menu.component,
      permission: menu.permission,
      keepAlive: menu.keepAlive,
      hidden: menu.hidden,
      scope: menu.scope,
    }));
  }
}
