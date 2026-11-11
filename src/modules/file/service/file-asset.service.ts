import { Injectable, Inject, Optional } from '@nestjs/common';
import { TenantQuotaService } from '../../tenant/service/tenant-quota.service.js';
import { BaseService } from '../../../core/crud/index.js';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../core/exceptions/error-code.js';
import { FileAssetEntity } from '../entity/file-asset.entity.js';
import type { FileCatalog, StoredFile } from '../file.ports.js';
import { FileMetadataWriteFailure } from '../file.ports.js';
import { assertBlobKey } from '../storage/blob-store.js';

/** 文件目录的数据库实现：读写统一复用 core 的上下文、租户范围和事务。 */
@Injectable()
export class FileAssetService
  extends BaseService<FileAssetEntity>
  implements FileCatalog
{
  @Optional()
  @Inject(TenantQuotaService)
  private readonly quota?: TenantQuotaService;
  async ready(): Promise<void> {
    const ds = this.crud.dataSource;
    this.crud.context.current();
    if (!ds.isInitialized || !ds.hasMetadata(FileAssetEntity))
      throw new BusinessException(
        ErrorCode.ServiceUnavailable,
        '文件目录尚未就绪',
        503,
      );
  }

  async insert(file: Omit<StoredFile, 'id'>): Promise<StoredFile> {
    await this.ready();
    assertBlobKey(file.key);
    const ctx = this.crud.context.current();
    if (!file.key.startsWith(`tenants/${ctx.tenantId}/`))
      throw new BusinessException(
        ErrorCode.Forbidden,
        '文件对象不属于当前租户',
        403,
      );
    if (
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 20 * 1024 * 1024 ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(
        file.mime,
      )
    )
      throw new BusinessException(ErrorCode.BadRequest, '文件元数据无效');
    const values = {
      name: file.key.split('/').at(-1)!,
      objectKey: file.key,
      mime: file.mime,
      bytes: file.bytes,
      sha256: file.sha256,
    };
    // 不接收任何身份/系统字段，由 insertRow 按事务上下文填租户和审计主体。
    let workFinished = false;
    let receipt: { id: string; name: string; mime: string; bytes: number };
    try {
      receipt = await this.transaction(async (tx) => {
        await this.quota?.assertStorage(
          tx.ctx.tenantId,
          file.bytes,
          tx.manager,
        );
        const id = await this.insertRow(tx, values);
        // 账本在这个事务中记录公开回执，崩溃重放不返回内部key/hash或单独的id。
        const result = {
          id,
          name: values.name,
          mime: values.mime,
          bytes: values.bytes,
        };
        workFinished = true;
        return result;
      });
    } catch (reason) {
      throw new FileMetadataWriteFailure(reason, !workFinished);
    }
    return {
      id: receipt.id,
      key: values.objectKey,
      mime: values.mime,
      bytes: values.bytes,
      sha256: values.sha256,
    };
  }

  async find(id: string): Promise<StoredFile | null> {
    await this.ready();
    const row = await this.select(this.crud.dataSource.manager, 'info')
      .addSelect(['e.objectKey', 'e.sha256'])
      .andWhere('e.id = :__fileId', { __fileId: id })
      .getOne();
    return row
      ? {
          id: row.id,
          key: row.objectKey,
          mime: row.mime,
          bytes: row.bytes,
          sha256: row.sha256,
        }
      : null;
  }
}
