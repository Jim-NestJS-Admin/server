import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import type { RequestContext } from '../../../core/tenant/request-context.js';
import type { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import { SystemCrudAudit } from './system-audit.service.js';

describe('硬删除审计事务约束（统一阶段执行）', () => {
  it('使用原事务manager写快照，过滤凭据；落库异常直接阻止删除', async () => {
    const insert = vi.fn().mockResolvedValue('1');
    const repos = {
      for: () => ({ insert }),
    } as unknown as TenantRepositoryFactory;
    const principal = {
      tenantId: '1',
      userId: '2',
      orgId: null,
      endpoint: 'admin' as const,
      ignoreTenant: false,
    };
    const context = { current: () => principal } as unknown as RequestContext;
    const audit = new SystemCrudAudit(repos, context);
    const manager = {} as EntityManager;
    const event = {
      resource: 'system/user',
      reason: 'purge' as const,
      ctx: principal,
      rows: [{ id: '3', passwordHash: '不能持久化' }],
      children: {},
    };
    await audit.hardDeleted(event, manager);
    expect(insert.mock.calls[0][1]).toBe(manager);
    expect(insert.mock.calls[0][0].snapshot.rows[0].passwordHash).toBe(
      '[已隐去]',
    );
    insert.mockRejectedValue(new Error('审计不可用'));
    await expect(audit.hardDeleted(event, manager)).rejects.toThrow(
      '审计不可用',
    );
  });
});
