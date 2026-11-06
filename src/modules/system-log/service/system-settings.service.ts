import { Inject, Injectable } from '@nestjs/common';
import { BaseService } from '../../../core/crud/base.service.js';
import type { CrudTx } from '../../../core/crud/crud.types.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import {
  SystemDictType,
  SystemDictItem,
  SystemParameter,
} from '../entity/system-log.entity.js';

@Injectable()
export class SystemDictTypeService extends BaseService<SystemDictType> {
  @Inject(TenantRepositoryFactory)
  private readonly repos: TenantRepositoryFactory;
  async items(
    code: string,
  ): Promise<{ items: { value: string; label: string }[] }> {
    const type = await this.repos
      .for(SystemDictType)
      .query('t')
      .where('t.code = :code AND t.enabled = :enabled', { code, enabled: true })
      .getOne();
    if (!type) return { items: [] };
    const rows = await this.repos
      .for(SystemDictItem)
      .query('i')
      .where('i.typeId = :id AND i.enabled = :enabled', {
        id: type.id,
        enabled: true,
      })
      .orderBy('i.rank', 'ASC')
      .addOrderBy('i.id', 'ASC')
      .getMany();
    return {
      items: rows.map((row) => ({ value: row.value, label: row.label })),
    };
  }
  protected override async beforeDelete(
    rows: SystemDictType[],
    tx: CrudTx,
  ): Promise<void> {
    if (
      await this.repos
        .for(SystemDictItem)
        .query('i', tx.manager)
        .where('i.typeId IN (:...ids)', { ids: rows.map((row) => row.id) })
        .getCount()
    )
      throw crudErrors.badRequest('字典仍有字典项，请先删除字典项');
  }
}
@Injectable()
export class SystemDictItemService extends BaseService<SystemDictItem> {
  @Inject(TenantRepositoryFactory)
  private readonly repos: TenantRepositoryFactory;
  protected override async beforeAdd(
    data: Partial<SystemDictItem>,
    tx: CrudTx,
  ): Promise<void> {
    const type = await this.repos
      .for(SystemDictType)
      .query('t', tx.manager)
      .where('t.id = :id', { id: data.typeId })
      .getOne();
    if (!type?.enabled) throw crudErrors.badRequest('字典类型不存在或已停用');
  }
}
@Injectable()
export class SystemParameterService extends BaseService<SystemParameter> {
  protected override async beforeAdd(
    data: Partial<SystemParameter>,
  ): Promise<void> {
    if (/(password|secret|token|credential|private.?key)/i.test(data.key ?? ''))
      throw crudErrors.badRequest('系统参数不能存放凭据，请使用服务端环境配置');
  }
}
