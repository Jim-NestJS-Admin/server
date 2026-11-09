import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  AuthEvents,
  type LoginEvent,
  type LoginFailReason,
} from '../../../core/auth/auth-events.js';
import {
  CrudAudit,
  type HardDeleteEvent,
} from '../../../core/crud/crud-audit.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import {
  SystemLoginLog,
  SystemOperationLog,
} from '../entity/system-log.entity.js';
import { auditSnapshot } from './audit-snapshot.js';

@Injectable()
export class SystemAuthEvents extends AuthEvents {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
  ) {
    super();
  }
  private async save(
    event: string,
    e: {
      tenantId: string;
      userId: string | null;
      username?: string;
      ip?: string;
      userAgent?: string;
      sessionId?: string;
    },
    success: boolean,
    reason: string | null = null,
  ): Promise<void> {
    try {
      await this.context.run({ tenantId: e.tenantId, userId: e.userId }, () =>
        this.repos.for(SystemLoginLog).insert({
          event,
          success,
          reason,
          username: e.username?.slice(0, 64) ?? null,
          ip: e.ip?.slice(0, 64) ?? null,
          userAgent: e.userAgent?.slice(0, 500) ?? null,
          sessionHash: e.sessionId
            ? createHash('sha256').update(e.sessionId).digest('hex')
            : null,
        }),
      );
    } catch {
      this.logger.warn('登录事件落库失败，需要检查日志存储；不影响认证结果');
    }
  }
  override loginSucceeded(
    e: LoginEvent & { sessionId: string },
  ): Promise<void> {
    return this.save('login', e, true);
  }
  override loginFailed(
    e: LoginEvent & { reason: LoginFailReason },
  ): Promise<void> {
    return this.save('login-failed', e, false, e.reason);
  }
  override loggedOut(e: {
    tenantId: string;
    userId: string;
    sessionId: string;
  }): Promise<void> {
    return this.save('logout', e, true);
  }
  override refreshReuseDetected(e: {
    tenantId: string;
    userId: string;
    sessionId: string;
    ip: string;
  }): Promise<void> {
    return this.save('refresh-reuse', e, false, 'revoked');
  }
}

@Injectable()
export class SystemCrudAudit extends CrudAudit {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
  ) {
    super();
  }
  async hardDeleted(
    event: HardDeleteEvent,
    manager: EntityManager,
  ): Promise<void> {
    const current = this.context.current();
    if (
      current.tenantId !== event.ctx.tenantId ||
      current.userId !== event.ctx.userId
    )
      throw new Error('审计身份与事务上下文不一致');
    const snapshot = auditSnapshot({
      rows: event.rows,
      children: event.children,
      masterId: event.masterId ?? null,
    });
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 4 * 1024 * 1024)
      throw new Error('审计快照过大，请拆分删除操作');
    // 沿用删除事务manager，写失败就让业务删除一起回滚。
    await this.repos.for(SystemOperationLog).insert(
      {
        action: event.reason,
        resource: event.resource,
        method: 'INTERNAL',
        success: true,
        status: 200,
        durationMs: 0,
        recordCount: event.rows.length,
        requestId: null,
        snapshot,
      },
      manager,
    );
  }
}

@Injectable()
export class SystemOperationRecorder {
  async configuration(
    manager: EntityManager,
    action: string,
    resource: string,
    previous: unknown,
    next: unknown,
  ): Promise<void> {
    const snapshot = auditSnapshot({ previous, next });
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 4 * 1024 * 1024)
      throw new Error('配置审计快照过大，拒绝写入');
    await this.repos.for(SystemOperationLog).insert(
      {
        action,
        resource,
        method: 'CONFIG',
        success: true,
        status: 200,
        durationMs: 0,
        recordCount: 1,
        requestId: null,
        snapshot,
      },
      manager,
    );
  }
  private readonly logger = new Logger('SystemOperationRecorder');
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
  ) {}
  async record(
    action: string,
    method: string,
    status: number,
    durationMs: number,
    requestId?: string,
  ): Promise<void> {
    const principal = this.context.peek();
    if (!principal?.userId) return;
    try {
      await this.context.run(principal, () =>
        this.repos.for(SystemOperationLog).insert({
          action,
          resource: action.split(':').slice(0, -1).join('/'),
          method: method.slice(0, 12),
          status,
          success: status < 400,
          durationMs: Math.min(Math.max(0, durationMs), 4294967295),
          recordCount: 0,
          requestId: requestId?.slice(0, 64) ?? null,
          snapshot: null,
        }),
      );
    } catch {
      this.logger.warn('操作日志落库失败，需要检查日志存储');
    }
  }
}
