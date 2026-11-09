import { Injectable } from '@nestjs/common';
import { CrudRuntime } from '../../../core/crud/crud.runtime.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { SystemField, SystemRoleField } from '../entity/system-field.entity.js';
import { SystemRole } from '../entity/system.entity.js';
import { SystemFieldCatalog } from './system-field.catalog.js';
import type { FieldConfigurationOverview } from '../dto/system-field.dto.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';

/** 配置页专用读模型：合并代码清单和当前租户覆盖，DTO随正式OpenAPI生成。 */
@Injectable()
export class SystemFieldOverview {
  constructor(
    private readonly runtime: CrudRuntime,
    private readonly repos: TenantRepositoryFactory,
    private readonly catalog: SystemFieldCatalog,
  ) {}
  async read(roleId?: string): Promise<FieldConfigurationOverview> {
    if (roleId) {
      const role = await this.repos
        .for(SystemRole)
        .query('r')
        .where('r.id = :id', { id: roleId })
        .getOne();
      if (!role || role.allPermissions)
        throw crudErrors.badRequest('角色不存在或为内置超级管理员');
    }
    const defaults = await this.repos.for(SystemField).query('f').getMany();
    const roles = roleId
      ? await this.repos
          .for(SystemRoleField)
          .query('f')
          .where('f.roleId = :roleId', { roleId })
          .getMany()
      : [];
    const byKey = (resource: string, field: string) => `${resource}/${field}`;
    const defaultMap = new Map(
      defaults.map((row) => [byKey(row.resource, row.field), row]),
    );
    const roleMap = new Map(
      roles.map((row) => [byKey(row.resource, row.field), row]),
    );
    return {
      fields: this.runtime.list().flatMap((meta) =>
        meta.fields.flatMap((field) => {
          const code = this.catalog.find(meta.permPrefix, field.property);
          if (!code) return [];
          const stored = defaultMap.get(byKey(meta.permPrefix, field.property));
          const effective = stored?.enabled ? stored : undefined;
          const target = roleId
            ? roleMap.get(byKey(meta.permPrefix, field.property))
            : stored;
          return [
            {
              resource: meta.permPrefix,
              resourceLabel: meta.label,
              field: field.property,
              label: field.label,
              codeDefault: code.default,
              codeMask: code.mask,
              codeDelegable: code.delegable,
              defaultState: effective?.state ?? code.default,
              defaultMask: effective?.mask ?? code.mask,
              defaultDelegable: effective
                ? effective.delegable
                : code.delegable,
              state: target?.state ?? null,
              mask: target?.mask ?? null,
              delegable: roleId ? null : (stored?.delegable ?? null),
              version: target?.version ?? 0,
            },
          ];
        }),
      ),
    };
  }
}
