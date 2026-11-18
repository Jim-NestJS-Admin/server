import { Inject, Injectable } from '@nestjs/common';
import type { CrudTx } from '../../../core/crud/crud.types.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { SystemOperationRecorder } from '../../system-log/service/system-audit.service.js';
import {
  SystemField,
  SystemRoleField,
  type SystemFieldRule,
} from '../entity/system-field.entity.js';
import { SystemRole } from '../entity/system.entity.js';
import { SystemCrudService } from './system-management.service.js';
import { SystemFieldCatalog } from './system-field.catalog.js';
import type { FieldConfigurationChange } from '../dto/system-field.dto.js';

abstract class FieldConfigurationService<
  T extends SystemFieldRule,
> extends SystemCrudService<T> {
  /** 整模块保存同一事务；编号和版本由后端当前租户内重新读取，不信任复制来源的编号。 */
  async saveConfigurations(
    changes: FieldConfigurationChange[],
    roleId?: string,
  ): Promise<{ count: number }> {
    return this.transaction(async (tx) => {
      if (roleId) {
        const role = await this.repos
          .for(SystemRole)
          .query('r', tx.manager)
          .where('r.id = :id', { id: roleId })
          .setLock('pessimistic_write')
          .getOne();
        if (!role || role.allPermissions)
          throw crudErrors.badRequest('角色不存在或为内置超级管理员');
      }
      const keys = new Set<string>();
      for (const change of [...changes].sort((a, b) =>
        `${a.resource}/${a.field}`.localeCompare(`${b.resource}/${b.field}`),
      )) {
        const key = `${change.resource}/${change.field}`;
        if (keys.has(key))
          throw crudErrors.badRequest('同一批不能重复配置同一字段');
        keys.add(key);
        if (!Object.hasOwn(change, 'state') || change.state === undefined)
          throw crudErrors.badRequest('必须明确选择状态或跟随默认');
        if (!roleId && change.state === null && change.delegable)
          throw crudErrors.badRequest('跟随默认时不能单独保留委派上限');
        if (roleId && change.delegable)
          throw crudErrors.badRequest('角色配置不能修改模块可委派上限');
        const code = await this.catalog.resolve(
          change.resource,
          change.field,
          tx.manager,
        );
        if (!code) throw crudErrors.badRequest('资源字段不存在或不允许配置');
        const query = this.select(tx.manager, 'update').where(
          'e.resource = :resource AND e.field = :field',
          { resource: change.resource, field: change.field },
        );
        if (roleId) query.andWhere('e.roleId = :roleId', { roleId });
        const existing = await query.setLock('pessimistic_write').getOne();
        if ((existing?.version ?? 0) !== change.version)
          throw crudErrors.versionConflict();
        const repo = this.repos.for(this.meta.entity);
        if (change.state === null) {
          if (existing) {
            await this.audit(tx, 'follow-default', existing, null);
            // 安全配置恢复默认即移除覆盖，删除前后留底和配置删除同事务提交。
            await repo.remove([existing.id], tx.manager);
          }
          continue;
        }
        await this.catalog.validateAsync(
          change.resource,
          change.field,
          change.state,
          change.mask,
          change.delegable,
          tx.manager,
        );
        const values = {
          resource: change.resource,
          field: change.field,
          state: change.state,
          mask: change.mask ?? code.mask,
          ...(roleId
            ? { roleId }
            : {
                delegable: change.delegable ?? null,
                enabled: true,
                configurable: true,
                source: 'admin',
              }),
        } as unknown as Partial<T>;
        await this.audit(
          tx,
          existing ? 'update' : 'add',
          existing ?? null,
          values,
        );
        if (existing) await repo.update([existing.id], values, tx.manager);
        else await this.insertRow(tx, values);
      }
      return { count: changes.length };
    });
  }
  @Inject(SystemFieldCatalog) protected readonly catalog: SystemFieldCatalog;
  @Inject(SystemOperationRecorder)
  protected readonly recorder: SystemOperationRecorder;
  protected async audit(
    tx: CrudTx,
    action: string,
    previous: unknown,
    next: unknown,
  ) {
    await this.recorder.configuration(
      tx.manager,
      action,
      this.meta.permPrefix,
      previous,
      next,
    );
  }
  protected override async afterAdd(row: T, tx: CrudTx) {
    await this.audit(tx, 'add', null, row);
  }
  protected override async beforeUpdate(
    changes: Partial<T>,
    existing: T,
    tx: CrudTx,
  ) {
    const merged = Object.assign({}, existing, changes);
    await this.validate(merged, tx);
    await this.audit(tx, 'update', existing, merged);
  }
  protected override async beforeAdd(data: Partial<T>, tx: CrudTx) {
    await this.validate(data, tx);
  }
  protected override async beforeDelete(rows: T[], tx: CrudTx) {
    await this.audit(tx, 'follow-default', rows, null);
  }
  protected abstract validate(data: Partial<T>, tx: CrudTx): Promise<void>;
}
@Injectable()
export class SystemFieldService extends FieldConfigurationService<SystemField> {
  protected async validate(
    data: Partial<SystemField>,
    tx: CrudTx,
  ): Promise<void> {
    const code = await this.catalog.validateAsync(
      data.resource!,
      data.field!,
      data.state!,
      data.mask,
      data.delegable,
      tx.manager,
    );
    data.mask ??= code.mask;
    data.delegable ??= null;
    data.enabled ??= true;
    data.configurable = true;
    data.source = 'admin';
  }
}
@Injectable()
export class SystemRoleFieldService extends FieldConfigurationService<SystemRoleField> {
  protected async validate(
    data: Partial<SystemRoleField>,
    tx: CrudTx,
  ): Promise<void> {
    const code = await this.catalog.validateAsync(
      data.resource!,
      data.field!,
      data.state!,
      data.mask,
      undefined,
      tx.manager,
    );
    data.mask ??= code.mask;
    const role = await this.reference(SystemRole, data.roleId!, tx);
    if (role.allPermissions)
      throw crudErrors.badRequest('内置超级管理员不接受字段覆盖');
  }
}
