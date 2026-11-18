import { Injectable } from '@nestjs/common';
import { effectiveOperationStatus } from './mcp-operation-status.js';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import {
  ActionRegistry,
  type RegisteredAction,
} from '../../../core/endpoint/action-registry.js';
import { ActionTransaction } from '../../../core/security/action-transaction.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { PermissionService } from '../../../core/permission/permission.service.js';
import { PermissionRegistry } from '../../../core/permission/permission-registry.js';
import { RedisService } from '../../../core/redis/redis.service.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../core/exceptions/error-code.js';
import { stableStringify } from '../../../core/swagger/swagger.js';
import { IdempotencyLedger } from '../../../core/security/idempotency.ledger.js';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import {
  OAuthRuntimeService,
  type OAuthDelegation,
} from '../../oauth/service/oauth-runtime.service.js';
import { OAuthClientService } from '../../oauth/service/oauth-client.service.js';
import { OAuthCrypto } from '../../oauth/service/oauth-crypto.js';
import { OAuthScopesService } from '../../oauth/service/oauth-scopes.service.js';
import { TenantQuotaService } from '../../tenant/service/tenant-quota.service.js';
import { SystemOAuthService } from '../../system/service/system-oauth.service.js';
import { NotifySecurityService } from '../../notify/service/notify-security.service.js';
import {
  McpSetting,
  McpOperation,
  McpUsage,
  McpEvent,
  McpExempt,
  McpApprover,
} from '../entity/mcp.entity.js';

interface Payload {
  identity: OAuthDelegation;
  input: Record<string, unknown>;
  targets: { id: string; version: number }[];
}
const hash = (value: unknown) =>
  createHash('sha256').update(stableStringify(value)).digest('hex');
const forbidden = () =>
  new BusinessException(ErrorCode.Forbidden, '没有权限或授权已失效', 403);

@Injectable()
export class McpService {
  constructor(
    readonly registry: ActionRegistry,
    private readonly context: RequestContext,
    private readonly repos: TenantRepositoryFactory,
    private readonly db: DataSource,
    private readonly permissions: PermissionService,
    private readonly permissionRegistry: PermissionRegistry,
    private readonly redis: RedisService,
    private readonly oauth: OAuthRuntimeService,
    private readonly clients: OAuthClientService,
    private readonly crypto: OAuthCrypto,
    private readonly scopes: OAuthScopesService,
    private readonly quota: TenantQuotaService,
    private readonly system: SystemOAuthService,
    private readonly notifications: NotifySecurityService,
    private readonly transactions: ActionTransaction,
    private readonly ledger: IdempotencyLedger,
    private readonly config: AppConfigService,
  ) {}
  private setting(manager?: EntityManager) {
    return this.repos.for(McpSetting).query('s', manager).getOne();
  }
  async gate(identity: OAuthDelegation, resource?: string) {
    if (!this.config.mcpEnabled || identity.tenantId === '0') throw forbidden();
    const setting = await this.setting();
    if (
      !setting?.enabled ||
      (resource &&
        setting.blocked.some(
          (item) => resource === item || resource.startsWith(`${item}.`),
        )) ||
      !(await this.permissions.permissions()).codes.includes('mcp:use')
    )
      throw forbidden();
    return setting;
  }
  async rate(identity: OAuthDelegation) {
    for (const [kind, id, limit] of [
      ['client', identity.clientId, 120],
      ['user', identity.userId, 60],
    ] as const) {
      const count = await this.redis.call((r) =>
        r.eval(
          "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60)end;return n",
          1,
          this.redis.tenantKey(
            identity.tenantId,
            'mcp',
            'rate',
            kind,
            hash(id),
          ),
        ),
      );
      if (Number(count) > limit)
        throw new BusinessException(
          ErrorCode.TooManyRequests,
          'MCP调用太频繁',
          429,
        );
    }
  }
  async budget(identity: OAuthDelegation) {
    await this.db.transaction(async (manager) => {
      const limit = await this.quota.mcpCallLimit(identity.tenantId, manager),
        month = new Date().toISOString().slice(0, 7);
      let usage = await this.repos
        .for(McpUsage)
        .query('u', manager)
        .andWhere('u.month=:month', { month })
        .setLock('pessimistic_write')
        .getOne();
      if (!usage) {
        const id = await this.repos
          .for(McpUsage)
          .insert({ month, calls: 0 }, manager);
        usage = await this.repos
          .for(McpUsage)
          .query('u', manager)
          .andWhere('u.id=:id', { id })
          .getOneOrFail();
      }
      if (limit !== null && usage.calls >= limit)
        throw new BusinessException(
          ErrorCode.TooManyRequests,
          '已达到套餐MCP月度调用上限',
          429,
        );
      await this.repos
        .for(McpUsage)
        .update([usage.id], { calls: usage.calls + 1 }, manager);
    });
  }
  async visible(identity: OAuthDelegation) {
    const setting = await this.gate(identity),
      allowed = new Set((await this.permissions.permissions()).codes);
    return this.registry
      .all()
      .filter(
        (action) =>
          allowed.has(action.permission) &&
          identity.scopes.includes(
            this.scopes.scopeFor(action.permission) ?? '',
          ) &&
          !setting.blocked.some(
            (item) =>
              action.resource === item ||
              action.resource.startsWith(`${item}.`),
          ),
      );
  }
  async describe(identity: OAuthDelegation, resource: string) {
    const actions = (await this.visible(identity)).filter(
      (action) => action.resource === resource,
    );
    if (!actions.length) throw crudErrors.notFound();
    const schema = actions.find((action) => action.action === 'schema');
    let fields: unknown = null;
    if (schema) {
      const raw = (await schema.invoke(identity, {})) as {
        fields?: Record<string, unknown>[];
        columns?: Record<string, unknown>[];
        fieldPerms?: Record<string, { state: string }>;
      };
      // 页面schema本身含隐藏字段的定义；对MCP仅输出当前可见字段，不返回原始schema。
      fields = (raw.columns ?? [])
        .filter(
          (field) => raw.fieldPerms?.[String(field.field)]?.state !== 'hidden',
        )
        .map((field) => ({
          field: field.field,
          label: field.label,
          state: raw.fieldPerms?.[String(field.field)]?.state ?? 'readonly',
        }));
    }
    return {
      resource,
      fields,
      actions: await Promise.all(
        actions.map(async (action) => ({
          action: action.action,
          permission: action.permission,
          risk: action.risk,
          read: action.read,
          inputSchema: await this.oauth.authorizeDelegation(
            identity,
            action.permission,
            async () => this.registry.inputSchema(action),
          ),
        })),
      ),
      query: this.registry.crud.get(resource.replaceAll('.', '/'))
        ? {
            format:
              '使用同一CRUD分页、eq、where、sort格式；字段筛选和排序仍由服务端权限白名单裁剪',
          }
        : null,
    };
  }
  async audit(
    identity: OAuthDelegation,
    action: RegisteredAction,
    event: string,
    operationId: string | null = null,
    manager?: EntityManager,
  ) {
    await this.repos.for(McpEvent).insert(
      {
        event,
        clientId: identity.clientId,
        resource: action.resource,
        action: action.action,
        operationId,
      },
      manager,
    );
  }
  async toolAudit(identity: OAuthDelegation, event: string) {
    await this.repos.for(McpEvent).insert({
      event,
      clientId: identity.clientId,
      resource: 'mcp',
      action: 'tools/call',
      operationId: null,
    });
  }
  async call(
    identity: OAuthDelegation,
    resource: string,
    name: string,
    input: Record<string, unknown>,
    requestId?: string,
  ) {
    const action = this.registry.get(resource, name);
    return this.oauth.authorizeDelegation(
      identity,
      action.permission,
      async () => {
        const setting = await this.gate(identity, resource);
        if (action.action === 'schema')
          return this.describe(identity, resource);
        if (action.read) {
          await this.audit(identity, action, 'call.started');
          try {
            const result = await action.invoke(identity, input);
            await this.audit(identity, action, 'call.succeeded');
            return result;
          } catch (error) {
            await this.audit(identity, action, 'call.rejected');
            throw error;
          }
        }
        if (!requestId || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId))
          throw crudErrors.badRequest(
            '写操作须提供8–64位requestId，重试沿用原值',
          );
        if (JSON.stringify(input).length > 65536)
          throw crudErrors.badRequest('MCP参数超过64KB');
        const requestHash = hash([
            identity.clientId,
            identity.userId,
            identity.orgId,
            requestId,
          ]),
          digest = hash([resource, name, input]);
        let row = await this.repos
          .for(McpOperation)
          .query('o')
          .andWhere('o.requestHash=:requestHash', { requestHash })
          .getOne();
        if (row) {
          if (row.digest !== digest || row.grantId !== identity.grantId)
            throw crudErrors.versionConflict();
          return this.receipt(row);
        }
        const targets = await this.registry.targets(action, input);
        const approver =
          identity.kind === 'human'
            ? identity.userId
            : (await this.approver(identity.clientId))?.approverId;
        if (!approver)
          throw crudErrors.badRequest('服务账号应用须先指定真人审批人');
        const id = await this.db.transaction(async (manager) => {
          await this.quota.mcpCallLimit(identity.tenantId, manager);
          const created = await this.repos.for(McpOperation).insert(
            {
              requestHash,
              digest,
              ownerId: identity.userId,
              approverId: approver,
              clientId: identity.clientId,
              grantId: identity.grantId,
              resource,
              action: name,
              permission: action.permission,
              status: 'pending',
              payloadCipher: this.crypto.encrypt(
                { identity, input, targets } satisfies Payload,
                requestHash,
              ),
              receipt: null,
              expiresAt: new Date(
                Math.min(Date.now() + 600000, identity.expires * 1000),
              ),
              confirmedBy: null,
              confirmedAt: null,
            },
            manager,
          );
          await this.audit(
            identity,
            action,
            'operation.created',
            created,
            manager,
          );
          return created;
        });
        row = await this.repos
          .for(McpOperation)
          .query('o')
          .andWhere('o.id=:id', { id })
          .getOneOrFail();
        const high =
          action.risk ||
          setting.confirmPermissions.includes(action.permission) ||
          (Array.isArray(input.ids) && input.ids.length > 1) ||
          (Array.isArray(input.items) && input.items.length > 1) ||
          name === 'batch';
        if (high && !(await this.exemption(identity, action.permission)))
          return this.receipt(row);
        return this.execute(row.id, null, high);
      },
    );
  }
  private receipt(row: McpOperation) {
    const status = effectiveOperationStatus(row);
    return {
      operationId: row.id,
      status,
      result: row.receipt,
      ...(status === 'pending'
        ? {
            confirmUrl: `${this.config.auth.adminOrigins[0]}/?mcp_operation=${row.id}`,
          }
        : {}),
    };
  }
  private approver(clientId: string, manager?: EntityManager) {
    return this.repos
      .for(McpApprover)
      .query('a', manager)
      .andWhere('a.clientId=:clientId', { clientId })
      .getOne();
  }
  private async exemption(
    identity: OAuthDelegation,
    permission: string,
    manager?: EntityManager,
  ) {
    if (identity.kind !== 'service') return null;
    return this.repos
      .for(McpExempt)
      .query('x', manager)
      .andWhere(
        'x.clientId=:clientId AND x.serviceUserId=:userId AND x.orgId=:orgId AND x.permission=:permission AND x.enabled=1',
        {
          clientId: identity.clientId,
          userId: identity.userId,
          orgId: identity.orgId,
          permission,
        },
      )
      .getOne();
  }
  private async operation(id: string, manager?: EntityManager, lock = false) {
    const query = this.repos
      .for(McpOperation)
      .query('o', manager)
      .addSelect('o.payloadCipher')
      .andWhere('o.id=:id', { id });
    if (lock) query.setLock('pessimistic_write');
    const row = await query.getOne();
    if (!row) throw crudErrors.notFound();
    return row;
  }
  private async mine(id: string) {
    const row = await this.operation(id),
      userId = this.context.current().userId;
    if (row.ownerId !== userId && row.approverId !== userId)
      throw crudErrors.notFound();
    return row;
  }
  async status(identity: OAuthDelegation, id: string) {
    const row = await this.operation(id);
    if (
      row.ownerId !== identity.userId ||
      row.clientId !== identity.clientId ||
      row.grantId !== identity.grantId ||
      row.orgId !== identity.orgId
    )
      throw crudErrors.notFound();
    return this.oauth.authorizeDelegation(
      identity,
      row.permission,
      async () => {
        await this.gate(identity, row.resource);
        return this.receipt(row);
      },
    );
  }
  async list() {
    const userId = this.context.current().userId;
    const rows = await this.repos
      .for(McpOperation)
      .query('o')
      .andWhere('(o.ownerId=:userId OR o.approverId=:userId)', { userId })
      .orderBy('o.id', 'DESC')
      .take(100)
      .getMany();
    return {
      list: rows.map((row) => ({
        ...this.receipt(row),
        resource: row.resource,
        action: row.action,
        clientId: row.clientId,
        orgId: row.orgId,
        expiresAt: row.expiresAt.toISOString(),
      })),
    };
  }
  async details(id: string) {
    const row = await this.mine(id),
      actor = this.context.current();
    const payload = this.crypto.decrypt<Payload>(
        row.payloadCipher,
        row.requestHash,
      ),
      action = this.registry.get(row.resource, row.action);
    const preview = await this.context.runFresh(
      { tenantId: actor.tenantId, userId: actor.userId, orgId: row.orgId },
      async () => {
        await this.permissions.authorize(row.permission);
        return this.registry.preview(action, payload.input);
      },
    );
    return {
      ...this.receipt(row),
      resource: row.resource,
      action: row.action,
      permission: row.permission,
      summary: this.registry.summary(action),
      applicationName:
        (await this.clients.find(row.clientId))?.name ?? row.clientId,
      clientId: row.clientId,
      ownerId: row.ownerId,
      orgId: row.orgId,
      approverId: row.approverId,
      expiresAt: row.expiresAt.toISOString(),
      parameters: preview,
      targets: payload.targets,
    };
  }
  async decide(id: string, approve: boolean) {
    const row = await this.mine(id),
      actor = this.context.current();
    if (row.approverId !== actor.userId) throw forbidden();
    if (row.status !== 'pending') return this.receipt(row);
    if (!approve) {
      return this.ledger.transaction(async (manager) => {
        const current = await this.operation(id, manager, true);
        if (current.status === 'pending') {
          await this.repos.for(McpOperation).update(
            [id],
            {
              status: 'rejected',
              confirmedBy: actor.userId,
              confirmedAt: new Date(),
            },
            manager,
          );
          const payload = this.crypto.decrypt<Payload>(
            current.payloadCipher,
            current.requestHash,
          );
          await this.audit(
            payload.identity,
            this.registry.get(row.resource, row.action),
            'operation.rejected',
            id,
            manager,
          );
        }
        return { operationId: id, status: 'rejected' };
      });
    }
    return this.execute(id, actor.userId, false);
  }
  private async execute(id: string, confirmer: string | null, exempt: boolean) {
    const row = await this.operation(id),
      payload = this.crypto.decrypt<Payload>(
        row.payloadCipher,
        row.requestHash,
      ),
      action = this.registry.get(row.resource, row.action),
      identity = payload.identity;
    if (row.status !== 'pending') return this.receipt(row);
    try {
      return await this.oauth.authorizeDelegation(
        identity,
        action.permission,
        async () => {
          await this.gate(identity, action.resource);
          if (confirmer)
            await this.context.runFresh(
              { ...identity, userId: confirmer },
              async () => {
                await this.permissions.authorize(action.permission);
              },
            );
          await this.transactions.run(
            {
              before: async (manager) => {
                await this.quota.mcpCallLimit(identity.tenantId, manager);
                const current = await this.operation(id, manager, true);
                if (
                  current.status !== 'pending' ||
                  current.expiresAt.getTime() <= Date.now()
                )
                  throw crudErrors.versionConflict();
                if (
                  identity.kind === 'service' &&
                  (await this.approver(identity.clientId, manager))
                    ?.approverId !== row.approverId
                )
                  throw forbidden();
                if (confirmer !== null && confirmer !== row.approverId)
                  throw forbidden();
                if (
                  exempt &&
                  !(await this.exemption(identity, action.permission, manager))
                )
                  throw forbidden();
                const policy = await this.setting(manager);
                if (
                  !confirmer &&
                  !exempt &&
                  (action.risk ||
                    policy?.confirmPermissions.includes(action.permission) ||
                    (Array.isArray(payload.input.ids) &&
                      payload.input.ids.length > 1) ||
                    (Array.isArray(payload.input.items) &&
                      payload.input.items.length > 1) ||
                    action.action === 'batch')
                )
                  throw forbidden();
                const latest = await this.registry.targets(
                  action,
                  payload.input,
                  manager,
                );
                if (hash(latest) !== hash(payload.targets))
                  throw crudErrors.versionConflict();
              },
              after: async (manager, result) => {
                const value = result as
                  { id?: unknown; count?: unknown } | undefined;
                const receipt = {
                  completed: true,
                  ...(typeof value?.id === 'string' ? { id: value.id } : {}),
                  ...(typeof value?.count === 'number'
                    ? { count: value.count }
                    : {}),
                };
                await this.repos.for(McpOperation).update(
                  [id],
                  {
                    status: 'succeeded',
                    receipt,
                    confirmedBy: confirmer,
                    confirmedAt: confirmer ? new Date() : null,
                    payloadCipher: this.crypto.encrypt(
                      { ...payload, input: {} },
                      row.requestHash,
                    ),
                  },
                  manager,
                );
                await this.audit(
                  identity,
                  action,
                  exempt
                    ? 'operation.exempt-executed'
                    : confirmer
                      ? 'operation.confirmed-executed'
                      : 'operation.executed',
                  id,
                  manager,
                );
                if (exempt)
                  await this.notifications.exemptExecuted(
                    id,
                    row.approverId!,
                    manager,
                  );
              },
            },
            () => action.invoke(identity, payload.input),
          );
          return this.receipt(await this.operation(id));
        },
      );
    } catch (error) {
      // 事务回滚后作废；临时依赖故障仍保留待确认，绝不猜测为执行成功。
      const status = error instanceof BusinessException ? error.getStatus() : 0;
      if ([400, 401, 403, 404, 409].includes(status))
        await this.db.transaction(async (manager) => {
          const current = await this.operation(id, manager, true);
          if (current.status === 'pending') {
            await this.repos.for(McpOperation).update(
              [id],
              {
                status:
                  current.expiresAt.getTime() <= Date.now()
                    ? 'expired'
                    : 'invalid',
              },
              manager,
            );
            await this.audit(
              identity,
              action,
              'operation.invalid',
              id,
              manager,
            );
          }
        });
      throw error;
    }
  }
  async configuration() {
    const setting = await this.setting();
    return {
      enabled: setting?.enabled ?? false,
      blocked: setting?.blocked ?? [],
      confirmPermissions: setting?.confirmPermissions ?? [],
      deployed: this.config.mcpEnabled,
      resources: [
        ...new Set(this.registry.all().map((action) => action.resource)),
      ],
      permissions: this.permissionRegistry.all().map((item) => item.code),
    };
  }
  private async admin() {
    if (
      !(await this.permissions.isSuperAdmin()) ||
      this.context.current().tenantId === '0'
    )
      throw forbidden();
  }
  async saveConfiguration(body: {
    enabled: boolean;
    blocked: string[];
    confirmPermissions: string[];
  }) {
    await this.admin();
    const resources = new Set(this.registry.all().map((item) => item.resource));
    if (
      body.blocked.some(
        (item) =>
          !resources.has(item) &&
          ![...resources].some((resource) => resource.startsWith(`${item}.`)),
      ) ||
      body.confirmPermissions.some((code) => !this.permissionRegistry.get(code))
    )
      throw crudErrors.badRequest('资源或权限码不存在');
    return this.ledger.transaction(async (manager) => {
      await this.quota.mcpCallLimit(this.context.current().tenantId, manager);
      const old = await this.setting(manager);
      const id = old
        ? old.id
        : await this.repos.for(McpSetting).insert(body, manager);
      if (old) await this.repos.for(McpSetting).update([id], body, manager);
      return { id };
    });
  }
  async delegations() {
    await this.admin();
    const approvers = await this.repos.for(McpApprover).query('a').getMany(),
      exemptions = await this.repos.for(McpExempt).query('e').getMany();
    return {
      approvers: approvers.map((row) => ({
        clientId: row.clientId,
        approverId: row.approverId,
      })),
      exemptions: exemptions.map((row) => ({
        clientId: row.clientId,
        serviceUserId: row.serviceUserId,
        orgId: row.orgId,
        permission: row.permission,
        enabled: row.enabled,
      })),
    };
  }
  async saveDelegation(body: {
    clientId: string;
    approverId: string;
    permission?: string;
    enabled?: boolean;
  }) {
    await this.admin();
    const client = await this.clients.find(body.clientId),
      human = await this.system.identity(body.approverId);
    if (
      !client?.serviceUserId ||
      !client.serviceOrgId ||
      human?.type !== 'human'
    )
      throw crudErrors.badRequest('应用须绑定服务身份，并选择有效真人审批人');
    if (
      body.permission &&
      !(await this.permissions.permissions()).codes.includes(body.permission)
    )
      throw forbidden();
    if (body.permission && !this.permissionRegistry.get(body.permission))
      throw crudErrors.badRequest('权限码不存在');
    const actor = this.context.current();
    await this.context.runFresh(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        orgId: client.serviceOrgId,
      },
      async () => {
        if (
          !(await this.permissions.isSuperAdmin()) ||
          (body.permission &&
            !(await this.permissions.permissions()).codes.includes(
              body.permission,
            ))
        )
          throw forbidden();
      },
    );
    await this.context.runFresh(
      {
        tenantId: actor.tenantId,
        userId: body.approverId,
        orgId: client.serviceOrgId,
      },
      async () => {
        await this.permissions.permissions();
      },
    );
    return this.ledger.transaction(async (manager) => {
      await this.quota.mcpCallLimit(this.context.current().tenantId, manager);
      const approver = await this.approver(body.clientId, manager);
      if (approver)
        await this.repos
          .for(McpApprover)
          .update([approver.id], { approverId: body.approverId }, manager);
      else
        await this.repos
          .for(McpApprover)
          .insert(
            { clientId: body.clientId, approverId: body.approverId },
            manager,
          );
      if (body.permission)
        await this.context.run(
          { ...this.context.current(), orgId: client.serviceOrgId },
          async () => {
            const old = await this.repos
              .for(McpExempt)
              .query('e', manager)
              .andWhere(
                'e.clientId=:clientId AND e.orgId=:orgId AND e.permission=:permission',
                {
                  clientId: body.clientId,
                  orgId: client.serviceOrgId,
                  permission: body.permission,
                },
              )
              .getOne();
            const value = {
              clientId: body.clientId,
              serviceUserId: client.serviceUserId!,
              permission: body.permission!,
              enabled: body.enabled ?? false,
            };
            if (old)
              await this.repos.for(McpExempt).update([old.id], value, manager);
            else await this.repos.for(McpExempt).insert(value, manager);
          },
        );
      await this.repos.for(McpEvent).insert(
        {
          event: body.permission
            ? body.enabled
              ? 'exemption.granted'
              : 'exemption.revoked'
            : 'approver.changed',
          clientId: body.clientId,
          resource: 'mcp.delegation',
          action: body.permission ?? 'approver',
          operationId: null,
        },
        manager,
      );
      return { id: body.clientId };
    });
  }
}
