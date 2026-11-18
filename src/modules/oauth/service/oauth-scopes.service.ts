import { Injectable } from '@nestjs/common';
import { PermissionRegistry } from '../../../core/permission/permission-registry.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import type { EntityManager } from 'typeorm';
import { OAuthScope } from '../entity/oauth.entity.js';
@Injectable()
export class OAuthScopesService {
  constructor(
    private readonly permissions: PermissionRegistry,
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
  ) {}
  async sync(manager: EntityManager) {
    for (const item of this.list().list) {
      const old = await this.repos
        .for(OAuthScope)
        .query('s', manager)
        .andWhere('s.code=:code', { code: item.code })
        .getOne();
      if (!old) await this.repos.for(OAuthScope).insert(item, manager);
      else if (
        JSON.stringify(old.permissions) !== JSON.stringify(item.permissions)
      )
        await this.repos
          .for(OAuthScope)
          .update([old.id], { permissions: item.permissions }, manager);
    }
  }
  scopeFor(code: string) {
    const meta = this.permissions.get(code);
    if (!meta || code.startsWith('platform:') || code.startsWith('dev:'))
      return null;
    return `${code.split(':')[0]}:${meta.risk === 'high' ? 'risk' : /:(page|list|info|tree)$/.test(code) ? 'read' : 'write'}`;
  }
  list() {
    const groups = new Map<string, string[]>();
    for (const { code } of this.permissions.all()) {
      const scope = this.scopeFor(code);
      if (scope) groups.set(scope, [...(groups.get(scope) ?? []), code]);
    }
    return {
      list: [...groups].map(([code, permissions]) => ({ code, permissions })),
    };
  }
}
