import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';
import { RequestContext } from './request-context.js';
import { PLATFORM_TENANT_ID, TENANT_ID_PATTERN } from './tenant.constants.js';

/** 平台操作审计的一条记录 */
export interface PlatformAuditEntry {
  /** provision：创建租户时初始化数据；cross-tenant-read：@IgnoreTenant 只读查询 */
  action: 'provision' | 'cross-tenant-read';
  /** 操作的平台用户 */
  userId: string | null;
  /** 目标租户；跨租户查询不确定具体租户时为 null */
  targetTenantId: string | null;
  /** 做了什么：初始化说明，或接口（控制器.方法） */
  detail: string;
}

/**
 * 平台审计的落地方式。默认只写结构化日志；操作日志模块可以提供持久化实现。
 * record 抛错时，调用方要拒绝这次操作（审计写不进去就不做）。
 */
export abstract class PlatformAuditSink {
  abstract record(entry: PlatformAuditEntry): Promise<void>;
}

@Injectable()
export class LoggerPlatformAuditSink extends PlatformAuditSink {
  private readonly logger = new Logger('PlatformAudit');
  async record(entry: PlatformAuditEntry): Promise<void> {
    this.logger.log({ event: 'platform.audit', ...entry });
  }
}

/**
 * 平台方的受控入口（契约 tenant.md 第 3 节）：
 * - assertPlatform：当前请求必须是平台用户；
 * - provision：创建租户时在新租户下写初始化数据（组织、管理员角色、管理员账号），
 *   先记审计再执行；新租户里的数据创建人为空（平台用户不是这个租户的用户）。
 * 其他场景平台不能写租户数据。
 */
@Injectable()
export class PlatformContext {
  constructor(
    private readonly context: RequestContext,
    private readonly audit: PlatformAuditSink,
  ) {}

  isPlatform(): boolean {
    return this.context.current().tenantId === PLATFORM_TENANT_ID;
  }

  assertPlatform(): void {
    if (!this.isPlatform())
      throw new BusinessException(
        ErrorCode.Forbidden,
        '只有平台管理员可以操作',
        HttpStatus.FORBIDDEN,
      );
  }

  async provision<R>(
    tenantId: string,
    reason: string,
    fn: () => Promise<R>,
  ): Promise<R> {
    this.assertPlatform();
    if (!TENANT_ID_PATTERN.test(tenantId) || tenantId === PLATFORM_TENANT_ID)
      throw new Error('只能初始化普通租户');
    const { userId } = this.context.current();
    await this.audit.record({
      action: 'provision',
      userId,
      targetTenantId: tenantId,
      detail: reason,
    });
    return this.context.run({ tenantId }, fn);
  }
}
