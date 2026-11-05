import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../core/exceptions/error-code.js';
import {
  FileAccess,
  FileCatalog,
  assertPrincipal,
  type StoredFile,
} from '../file.ports.js';
import { FILE_POLICY, inspectFile, type FilePolicy } from '../file.policy.js';
import { BlobStore, assertBlobKey } from '../storage/blob-store.js';

const missing = () =>
  new BusinessException(ErrorCode.NotFound, '文件不存在或无权访问', 404);
const digest = (data: Buffer) =>
  createHash('sha256').update(data).digest('hex');
@Injectable()
export class FileService {
  private readonly logger = new Logger('FileService');
  constructor(
    @Inject(FileAccess) private readonly access: FileAccess,
    @Inject(FileCatalog) private readonly catalog: FileCatalog,
    @Inject(BlobStore) private readonly store: BlobStore,
    @Inject(FILE_POLICY) private readonly policy: FilePolicy,
  ) {}
  private receipt(file: StoredFile) {
    return {
      id: file.id,
      name: file.key.split('/').at(-1)!,
      mime: file.mime,
      bytes: file.bytes,
    };
  }
  async upload(data: Buffer) {
    const principal = await this.access.current('upload');
    assertPrincipal(principal);
    await this.catalog.ready();
    const detected = await inspectFile(data, this.policy);
    const key = `tenants/${principal.tenantId}/${randomUUID()}.${detected.ext}`;
    await this.store.put(key, data, detected.mime);
    try {
      const file = await this.catalog.insert({
        key,
        mime: detected.mime,
        bytes: data.length,
        sha256: digest(data),
      });
      return this.receipt(file);
    } catch (reason) {
      try {
        await this.store.discard(key);
      } catch {
        this.logger.error(
          '文件元数据保存失败后的对象清理未完成，需要维护任务清理孤立对象',
        );
      }
      throw reason;
    }
  }
  async download(id: string) {
    const principal = await this.access.current('read');
    assertPrincipal(principal);
    const file = await this.catalog.find(id);
    // 即使未来 Catalog 实现出错，也不能用别的租户的对象名去读取存储。
    if (!file || !file.key.startsWith(`tenants/${principal.tenantId}/`))
      throw missing();
    assertBlobKey(file.key);
    const data = await this.store.get(file.key, this.policy.maxBytes);
    if (data.length !== file.bytes || digest(data) !== file.sha256)
      throw new BusinessException(
        ErrorCode.ServiceUnavailable,
        '文件暂不可用',
        503,
      );
    return { ...this.receipt(file), data };
  }
}
