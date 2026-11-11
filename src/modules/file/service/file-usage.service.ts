import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { FileAssetEntity } from '../entity/file-asset.entity.js';
@Injectable()
export class FileUsageService {
  constructor(private readonly repos: TenantRepositoryFactory) {}
  async bytes(manager?: EntityManager): Promise<bigint> {
    const query = this.repos
      .for(FileAssetEntity)
      .query('f', manager)
      .withDeleted()
      .select(['f.id', 'f.bytes']);
    if (manager?.queryRunner?.isTransactionActive)
      query.setLock('pessimistic_read');
    return (await query.getMany()).reduce(
      (sum, row) => sum + BigInt(row.bytes),
      0n,
    );
  }
}
