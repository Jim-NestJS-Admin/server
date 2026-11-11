import { BusinessException } from '../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../core/exceptions/error-code.js';

export type FileAction = 'upload' | 'read';
export interface FilePrincipal {
  tenantId: string;
  userId: string;
}
/** T05/T06 的适配器必须每次验证后台会话、当前组织及动作权限，不能从请求体读身份。 */
export abstract class FileAccess {
  abstract current(action: FileAction): Promise<FilePrincipal>;
}
export function assertPrincipal(principal: FilePrincipal): void {
  if (
    typeof principal?.tenantId !== 'string' ||
    typeof principal?.userId !== 'string' ||
    !/^(?:0|[1-9]\d{0,19})$/.test(principal?.tenantId) ||
    !/^[1-9]\d{0,19}$/.test(principal?.userId)
  )
    throw new BusinessException(ErrorCode.Unauthorized, '请先登录', 401);
}
export class DenyFileAccess extends FileAccess {
  async current(_action: FileAction): Promise<FilePrincipal> {
    throw new BusinessException(ErrorCode.Unauthorized, '请先登录', 401);
  }
}
export interface StoredFile {
  id: string;
  key: string;
  mime: string;
  bytes: number;
  sha256: string;
}
/** 仅确定尚未进入提交阶段时才允许立即补偿删除对象。 */
export class FileMetadataWriteFailure extends Error {
  constructor(
    readonly reason: unknown,
    readonly commitNotAttempted: boolean,
  ) {
    super('文件元数据写入未完成');
  }
}
/**
 * T03 全部完成并接入 T04 后，由继承 BaseService 的模块内 Service 实现持久化。
 * 查询必须使用 core 的当前上下文/范围，插入必须由 core 填充租户，不接收 tenantId 参数。
 * 当前不提供内存或默认租户的生产替身。
 */
export abstract class FileCatalog {
  abstract ready(): Promise<void>;
  abstract insert(file: Omit<StoredFile, 'id'>): Promise<StoredFile>;
  abstract find(id: string): Promise<StoredFile | null>;
}
export class UnconfiguredFileCatalog extends FileCatalog {
  async ready(): Promise<never> {
    throw new BusinessException(
      ErrorCode.ServiceUnavailable,
      '文件服务暂未就绪',
      503,
    );
  }
  async insert(_file: Omit<StoredFile, 'id'>): Promise<never> {
    return this.ready();
  }
  async find(_id: string): Promise<never> {
    return this.ready();
  }
}
