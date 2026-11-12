import { Injectable } from '@nestjs/common';
import {
  PlatformAuditSink,
  type PlatformAuditEntry,
} from '../../../core/tenant/platform-context.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { SystemOperationLog } from '../entity/system-log.entity.js';
/** 跨租户读取/初始化的审计独立落在平台；写入失败原样上抛，由core拒绝操作。 */
@Injectable()
export class SystemPlatformAuditSink extends PlatformAuditSink {
  constructor(
    private readonly context: RequestContext,
    private readonly repos: TenantRepositoryFactory,
  ) {
    super();
  }
  async record(entry: PlatformAuditEntry): Promise<void> {
    await this.context.run({ tenantId: '0', userId: entry.userId }, () =>
      this.repos.for(SystemOperationLog).insert({
        action: 'platform:' + entry.action,
        resource: entry.detail.slice(0, 200),
        method: 'AUDIT',
        success: true,
        status: 200,
        durationMs: 0,
        recordCount: 1,
        requestId: null,
        snapshot: entry,
      }),
    );
  }
}
