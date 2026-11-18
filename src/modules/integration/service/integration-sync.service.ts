import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IdempotencyLedger } from '../../../core/security/idempotency.ledger.js';
import { IntegrationCrypto } from './integration-crypto.js';
import { RedisService } from '../../../core/redis/redis.service.js';
import { withIntegrationLease } from './integration-lease.js';
import { WorkflowRuntimeService } from '../../workflow/service/workflow-runtime.service.js';
import { DataSource } from 'typeorm';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { SessionService } from '../../../core/auth/session.service.js';
import { PermissionService } from '../../../core/permission/permission.service.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { SystemIntegrationService } from '../../system/service/system-integration.service.js';
import {
  IntegrationApp,
  IntegrationSyncLog,
  OrgSocial,
  UserSocial,
  IntegrationInbox,
} from '../entity/integration.entity.js';
import { IntegrationAppService } from './integration-app.service.js';
import { WecomAdapter, type PlatformMember } from './wecom-adapter.js';

@Injectable()
export class IntegrationSyncService {
  constructor(
    private readonly apps: IntegrationAppService,
    private readonly adapter: WecomAdapter,
    private readonly db: DataSource,
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
    private readonly system: SystemIntegrationService,
    private readonly sessions: SessionService,
    private readonly permissions: PermissionService,
    private readonly runtime: WorkflowRuntimeService,
    private readonly redis: RedisService,
    private readonly ledger: IdempotencyLedger,
    private readonly crypto: IntegrationCrypto,
  ) {}
  async enqueue(app: IntegrationApp) {
    if (!app.enabled) throw crudErrors.badRequest('企业微信尚未启用');
    const eventKey = randomUUID().replaceAll('-', '');
    return this.ledger.transaction(async (manager) => {
      await this.repos.for(IntegrationInbox).insert(
        {
          appId: app.id,
          eventKey,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: new Date(),
          payloadCipher: this.crypto.encrypt(
            '<xml><Event><![CDATA[manual_sync]]></Event></xml>',
            `${this.context.current().tenantId}:inbox:${eventKey}`,
          ),
        },
        manager,
      );
      return { id: app.id };
    });
  }
  async sync() {
    return withIntegrationLease(
      this.redis,
      this.context.current().tenantId,
      'directory',
      (assertOwned) => this.syncLocked(assertOwned),
    );
  }
  private async syncLocked(assertOwned: () => Promise<void>) {
    const app = await this.apps.configured();
    if (!app) throw crudErrors.badRequest('企业微信尚未启用');
    const secret = this.apps.credentials(app).secret;
    // 完整抓取成功后才开写事务，避免网络失败留下半套组织。
    const departments = await this.adapter.departments(app, secret);
    if (
      !departments.length ||
      departments.length > 10000 ||
      new Set(departments.map((d) => d.id)).size !== departments.length
    )
      throw crudErrors.badRequest('企业微信部门目录不完整或超限');
    for (const d of departments)
      if (
        !Number.isSafeInteger(d.id) ||
        d.id < 1 ||
        !Number.isSafeInteger(d.parentid) ||
        d.parentid < 0 ||
        typeof d.name !== 'string' ||
        !d.name ||
        d.name.length > 100
      )
        throw crudErrors.badRequest('企业微信部门数据无效');
    const members = new Map<string, PlatformMember>();
    for (const d of departments)
      for (const m of await this.adapter.members(app, secret, d.id)) {
        if (
          typeof m.userid !== 'string' ||
          !m.userid ||
          m.userid.length > 100 ||
          typeof m.name !== 'string' ||
          !m.name ||
          m.name.length > 100 ||
          !Array.isArray(m.department) ||
          ![1, 2, 4, 5].includes(m.status)
        )
          throw crudErrors.badRequest('企业微信成员数据无效');
        members.set(m.userid, m);
        if (members.size > 50000)
          throw crudErrors.badRequest('企业微信成员数超限');
      }
    const deleted: string[] = [];
    for (const bound of await this.repos
      .for(UserSocial)
      .query('s')
      .andWhere('s.corpId = :corpId', { corpId: app.corpId })
      .getMany())
      if (
        !members.has(bound.externalId) &&
        !(await this.adapter.memberExists(app, secret, bound.externalId))
      )
        deleted.push(bound.externalId);
    const disabled: string[] = [];
    const tenantId = this.context.current().tenantId;
    const prefix = `wecom:${app.corpId}:`;
    const result = await this.db.transaction(async (manager) => {
      await assertOwned();
      const locked = await this.repos
        .for(IntegrationApp)
        .query('a', manager)
        .andWhere('a.id = :id', { id: app.id })
        .setLock('pessimistic_write')
        .getOne();
      if (!locked?.enabled || locked.version !== app.version)
        throw crudErrors.versionConflict();
      await this.system.requireLocalOrganization(app.mountOrgId, manager);
      const mapping = new Map<number, string>();
      let remaining = [...departments];
      while (remaining.length) {
        const ready = remaining.filter(
          (d) => d.parentid === 0 || mapping.has(d.parentid),
        );
        if (!ready.length)
          throw crudErrors.badRequest('企业微信部门存在循环或缺失父级');
        for (const d of ready) {
          const organizationId = await this.system.organization(
            prefix + 'org:' + d.id,
            d.name,
            d.parentid === 0 ? app.mountOrgId : mapping.get(d.parentid)!,
            Math.max(0, Math.min(1000000, d.order || 0)),
            manager,
          );
          mapping.set(d.id, organizationId);
          const old = await this.repos
            .for(OrgSocial)
            .query('s', manager)
            .andWhere('s.corpId = :corpId AND s.externalId = :externalId', {
              corpId: app.corpId,
              externalId: String(d.id),
            })
            .getOne();
          if (!old)
            await this.repos.for(OrgSocial).insert(
              {
                organizationId,
                corpId: app.corpId,
                externalId: String(d.id),
              },
              manager,
            );
        }
        remaining = remaining.filter((d) => !mapping.has(d.id));
      }
      for (const m of members.values()) {
        const orgIds = [...new Set(m.department.map((id) => mapping.get(id)))];
        if (!orgIds.length || orgIds.some((id) => !id))
          throw crudErrors.badRequest(
            '企业微信成员所属部门不在可见范围，已停止同步',
          );
        const defaultOrgId =
          mapping.get(m.main_department ?? m.department[0]) ?? orgIds[0]!;
        const user = await this.system.member(
          {
            tenantId,
            source: prefix + 'user:' + m.userid,
            name: m.name,
            orgIds: orgIds as string[],
            defaultOrgId,
            defaultRoleId: app.defaultRoleId,
            enabled: m.status === 1,
          },
          manager,
        );
        if (user.disabled) disabled.push(user.id);
        const old = await this.repos
          .for(UserSocial)
          .query('s', manager)
          .andWhere('s.corpId = :corpId AND s.externalId = :externalId', {
            corpId: app.corpId,
            externalId: m.userid,
          })
          .getOne();
        if (!old)
          await this.repos.for(UserSocial).insert(
            {
              userId: user.id,
              corpId: app.corpId,
              platform: 'wecom',
              externalId: m.userid,
            },
            manager,
          );
      }
      // 缺失可能表示应用可见范围缩小，不能据此批量停用员工；删除事件单独核对处理。
      for (const externalId of deleted) {
        const userId = await this.system.disable(
          prefix + 'user:' + externalId,
          manager,
        );
        if (userId) disabled.push(userId);
      }
      await this.repos.for(IntegrationSyncLog).insert(
        {
          appId: app.id,
          status: 'completed',
          organizations: mapping.size,
          users: members.size,
          detail: '可见范围同步完成；缺失对象保留，删除事件另行核对',
        },
        manager,
      );
      return { id: app.id };
    });
    for (const id of disabled) {
      await this.sessions.revokeUser(tenantId, id);
      await this.context.run({ tenantId }, () => this.runtime.departed(id));
    }
    await this.permissions.bumpVersion(tenantId);
    return result;
  }
}
