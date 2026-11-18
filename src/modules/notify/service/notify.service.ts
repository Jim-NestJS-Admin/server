import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { BaseService } from '../../../core/crud/base.service.js';
import type { CrudAction } from '../../../core/crud/crud.types.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { IdempotencyLedger } from '../../../core/security/idempotency.ledger.js';
import { NotifyMessage } from '../entity/notify.entity.js';

@Injectable()
export class NotifyMessageService extends BaseService<NotifyMessage> {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly ledger: IdempotencyLedger,
    private readonly db: DataSource,
  ) {
    super();
  }
  protected override select(manager: EntityManager, action: CrudAction) {
    return super
      .select(manager, action)
      .andWhere('e.recipientId = :recipient', {
        recipient: this.crud.context.current().userId,
      });
  }
  async markRead(id: string) {
    return this.ledger.transaction(async (manager) => {
      const row = await this.select(manager, 'info')
        .andWhere('e.id = :id', { id })
        .setLock('pessimistic_write')
        .getOne();
      if (!row) throw crudErrors.notFound();
      if (!row.readAt)
        await this.repos
          .for(NotifyMessage)
          .update([id], { readAt: new Date() }, manager);
      return { id };
    });
  }
  async unread() {
    return {
      count: await this.select(this.db.manager, 'page')
        .andWhere('e.readAt IS NULL')
        .getCount(),
    };
  }
}
