import { Injectable } from '@nestjs/common';
import {
  FieldPermSource,
  type FieldRule,
  type RoleFieldRule,
} from '../../../core/field-perm/field-perm-source.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { SystemField, SystemRoleField } from '../entity/system-field.entity.js';
import { SystemRole } from '../entity/system.entity.js';
import { SystemFieldCatalog } from './system-field.catalog.js';

@Injectable()
export class SystemFieldSource extends FieldPermSource {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
    private readonly catalog: SystemFieldCatalog,
  ) {
    super();
  }
  private tenant(tenantId: string) {
    const ctx = this.context.current();
    if (ctx.ignoreTenant || ctx.tenantId !== tenantId)
      throw new Error('字段配置租户与当前上下文不一致');
  }
  async loadFieldDefaults(tenantId: string): Promise<FieldRule[]> {
    this.tenant(tenantId);
    const rows = await this.repos
      .for(SystemField)
      .query('f')
      .where('f.enabled = :enabled', { enabled: true })
      .getMany();
    return rows
      .filter((row) => this.catalog.find(row.resource, row.field))
      .map((row) => ({
        resource: row.resource,
        field: row.field,
        state: row.state,
        mask: row.mask,
      }));
  }
  async loadRoleFields(tenantId: string): Promise<RoleFieldRule[]> {
    this.tenant(tenantId);
    const roles = await this.repos
      .for(SystemRole)
      .query('r')
      .where('r.enabled = :enabled', { enabled: true })
      .getMany();
    const ids = new Set(roles.map((role) => role.id));
    const rows = await this.repos.for(SystemRoleField).query('f').getMany();
    return rows
      .filter(
        (row) =>
          ids.has(row.roleId) && this.catalog.find(row.resource, row.field),
      )
      .map((row) => ({
        roleId: row.roleId,
        resource: row.resource,
        field: row.field,
        state: row.state,
        mask: row.mask,
      }));
  }
}
