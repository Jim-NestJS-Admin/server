import { SystemDictionaryService } from './system-dictionary.service.js';
import type { PageQuery } from '../../../core/crud/base.service.js';
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
  @Inject(SystemDictionaryService)
  private readonly dictionaries: SystemDictionaryService;
  async items(code: string) {
    return { items: await this.dictionaries.options(code) };
  }
  override async page(query: PageQuery, exportLimit?: number) {
    if (query.eq?.builtin === true) {
      await this.dictionaries.assertSystemManager();
      return this.dictionaries.platform(() => super.page(query, exportLimit));
    }
    return super.page(
      { ...query, eq: { ...query.eq, builtin: false } },
      exportLimit,
    );
  }
  override async info(id: string) {
    return this.dictionaries.inOwner(
      await this.dictionaries.owner(id, false),
      () => super.info(id),
    );
  }
  override async add(data: Partial<SystemDictType>, children?: unknown) {
    if (data.builtin === true) {
      await this.dictionaries.assertSystemManager();
      return this.dictionaries.platform(() => super.add(data, children));
    }
    return super.add({ ...data, builtin: false }, children);
  }
  override async update(
    id: string,
    version: number,
    data: Partial<SystemDictType>,
    children?: unknown,
  ) {
    return this.dictionaries.inOwner(
      await this.dictionaries.owner(id, false),
      () => super.update(id, version, data, children),
    );
  }
  override async delete(ids: string[]) {
    // 系统字典禁止删除；不能把平台与本租户的编号混合到一次删除里。
    for (const id of ids)
      if (
        (await this.dictionaries.owner(id, false)) !==
        this.dictionaries.tenant()
      )
        throw crudErrors.badRequest('系统字典不能删除');
    return super.delete(ids);
  }
  protected override async beforeAdd(data: Partial<SystemDictType>) {
    if (Boolean(data.builtin) !== Boolean(data.code?.startsWith('sys.')))
      throw crudErrors.badRequest(
        '系统字典必须使用sys.前缀，业务字典不能使用该前缀',
      );
    if (data.builtin) await this.dictionaries.assertSystemManager();
  }
  protected override async beforeUpdate(
    data: Partial<SystemDictType>,
    row: SystemDictType,
  ) {
    if (data.builtin !== undefined && data.builtin !== row.builtin)
      throw crudErrors.badRequest('不能更改字典的内置属性');
    if (row.builtin) {
      await this.dictionaries.assertSystemManager();
      if (data.code !== undefined && data.code !== row.code)
        throw crudErrors.badRequest('系统字典编码不能修改');
    } else if (data.code?.startsWith('sys.'))
      throw crudErrors.badRequest('业务字典不能使用sys.前缀');
  }
  protected override async beforeDelete(
    rows: SystemDictType[],
    tx: CrudTx,
  ): Promise<void> {
    if (rows.some((row) => row.builtin))
      throw crudErrors.badRequest('系统字典不能删除');
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
  @Inject(SystemDictionaryService)
  private readonly dictionaries: SystemDictionaryService;
  override async page(query: PageQuery, exportLimit?: number) {
    const typeId = query.eq?.typeId;
    if (typeof typeId !== 'string') {
      if (this.dictionaries.tenant() === '0')
        await this.dictionaries.assertSystemManager();
      return super.page(query, exportLimit);
    }
    const owner = await this.dictionaries.owner(typeId, false);
    return this.dictionaries.inOwner(owner, () =>
      super.page(query, exportLimit),
    );
  }
  override async info(id: string) {
    return this.dictionaries.inOwner(
      await this.dictionaries.owner(id, true),
      () => super.info(id),
    );
  }
  override async add(data: Partial<SystemDictItem>, children?: unknown) {
    if (!data.typeId) throw crudErrors.badRequest('请选择字典');
    return this.dictionaries.inOwner(
      await this.dictionaries.owner(data.typeId, false),
      () => super.add(data, children),
    );
  }
  override async update(
    id: string,
    version: number,
    data: Partial<SystemDictItem>,
    children?: unknown,
  ) {
    return this.dictionaries.inOwner(
      await this.dictionaries.owner(id, true),
      () => super.update(id, version, data, children),
    );
  }
  override async delete(ids: string[]) {
    for (const id of ids)
      if (
        (await this.dictionaries.owner(id, true)) !== this.dictionaries.tenant()
      )
        throw crudErrors.badRequest('系统字典项不能删除');
    return super.delete(ids);
  }
  protected override async beforeAdd(
    data: Partial<SystemDictItem>,
    tx: CrudTx,
  ) {
    const type = await this.dictionaries.type(data.typeId!, tx.manager);
    if (type.builtin) await this.dictionaries.assertSystemManager();
    if (!type.enabled) throw crudErrors.badRequest('字典类型已停用');
  }
  protected override async beforeUpdate(
    data: Partial<SystemDictItem>,
    row: SystemDictItem,
    tx: CrudTx,
  ) {
    const type = await this.dictionaries.type(row.typeId, tx.manager);
    if (type.builtin) {
      await this.dictionaries.assertSystemManager();
      if (data.value !== undefined && data.value !== row.value)
        throw crudErrors.badRequest('系统字典值不能修改');
    }
  }
  protected override async beforeDelete(rows: SystemDictItem[], tx: CrudTx) {
    for (const row of rows)
      if ((await this.dictionaries.type(row.typeId, tx.manager)).builtin)
        throw crudErrors.badRequest('系统字典项不能删除');
  }
  protected override async afterAdd(row: SystemDictItem, tx: CrudTx) {
    await this.dictionaries.touch(row.typeId, tx.manager);
  }
  protected override async afterUpdate(row: SystemDictItem, tx: CrudTx) {
    await this.dictionaries.touch(row.typeId, tx.manager);
  }
  protected override async afterDelete(rows: SystemDictItem[], tx: CrudTx) {
    for (const id of new Set(rows.map((row) => row.typeId)))
      await this.dictionaries.touch(id, tx.manager);
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
