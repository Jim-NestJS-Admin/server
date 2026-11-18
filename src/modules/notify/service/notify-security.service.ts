import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { NotifyMessage } from '../entity/notify.entity.js';
/** 安全提醒只带操作引用；与免确认业务写入同事务，不经过外部发送。 */
@Injectable()
export class NotifySecurityService {
  constructor(private readonly repos: TenantRepositoryFactory) {}
  async exemptExecuted(
    operationId: string,
    recipientId: string,
    manager: EntityManager,
  ) {
    await this.repos.for(NotifyMessage).insert(
      {
        eventKey: `mcp-exempt:${operationId}`,
        recipientId,
        event: 'mcp.exempt',
        title: '服务账号已执行一项免确认操作，请检查调用记录',
        instanceId: operationId,
        taskId: null,
        readAt: null,
      },
      manager,
    );
  }
}
