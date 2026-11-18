import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { BaseService } from '../../../core/crud/base.service.js';
import type { CrudAction } from '../../../core/crud/crud.types.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { IdempotencyLedger } from '../../../core/security/idempotency.ledger.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { OAuthGrant, OAuthEvent } from '../entity/oauth.entity.js';
import { OAuthAdapterService } from './oauth-adapter.service.js';
@Injectable()
export class OAuthGrantService extends BaseService<OAuthGrant> {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly ledger: IdempotencyLedger,
    private readonly adapter: OAuthAdapterService,
    private readonly db: DataSource,
  ) {
    super();
  }
  protected override select(manager: EntityManager, action: CrudAction) {
    return super.select(manager, action).andWhere('e.ownerId=:owner', {
      owner: this.crud.context.current().userId,
    });
  }
  async mine() {
    const rows = await this.select(this.db.manager, 'page')
      .orderBy('e.id', 'DESC')
      .take(200)
      .getMany();
    return {
      list: rows.map((row) => ({
        id: row.id,
        clientId: row.clientId,
        orgId: row.orgId ?? '',
        audience: row.audience,
        active: row.active,
        scopes: row.scopes,
      })),
    };
  }
  async revoke(id: string) {
    const result = await this.ledger.transaction(async (manager) => {
      const row = await this.select(manager, 'info')
        .andWhere('e.id=:id', { id })
        .setLock('pessimistic_write')
        .getOne();
      if (!row) throw crudErrors.notFound();
      await this.repos.for(OAuthGrant).update([id], { active: false }, manager);
      await this.repos.for(OAuthEvent).insert(
        {
          action: 'grant.revoked',
          clientId: row.clientId,
          grantId: row.grantId,
        },
        manager,
      );
      return { id, grantId: row.grantId, clientId: row.clientId };
    });
    await this.adapter.revokeGrant(result.grantId, result.clientId);
    return { id };
  }
}
