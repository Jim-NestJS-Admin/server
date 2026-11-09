import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { CrudRuntime } from '../../../core/crud/crud.runtime.js';
import type { CrudDisplaySource } from '../../../core/crud/crud-display.js';
import { SystemOrg, SystemUser } from '../entity/system.entity.js';

/**
 * 列表显示名（创建人、修改人、所属组织）：启动时注册到 CRUD 运行环境。
 * 只按传入的租户和编号查名称，包括已删除的用户和组织（历史记录照样显示名字）；不返回其他字段。
 */
@Injectable()
export class SystemDisplaySource implements CrudDisplaySource, OnModuleInit {
  constructor(
    private readonly runtime: CrudRuntime,
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit(): void {
    this.runtime.setDisplaySource(this);
  }

  async users(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const rows = await this.dataSource.getRepository(SystemUser).find({
      select: { id: true, username: true, nickname: true },
      where: { tenantId, id: In(ids) },
      withDeleted: true,
    });
    return new Map(rows.map((u) => [String(u.id), u.nickname || u.username]));
  }

  async orgs(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const rows = await this.dataSource.getRepository(SystemOrg).find({
      select: { id: true, name: true },
      where: { tenantId, id: In(ids) },
      withDeleted: true,
    });
    return new Map(rows.map((o) => [String(o.id), o.name]));
  }
}
