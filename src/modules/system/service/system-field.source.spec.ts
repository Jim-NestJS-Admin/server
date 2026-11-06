import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { SystemFieldSource } from './system-field.source.js';
import type { SystemFieldCatalog } from './system-field.catalog.js';
import type { RequestContext } from '../../../core/tenant/request-context.js';
import type { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';

describe('字段配置数据来源', () => {
  it('租户上下文不匹配时先拒绝，不能用入参切换租户', async () => {
    const repos = { for: vi.fn() };
    const source = new SystemFieldSource(
      repos as unknown as TenantRepositoryFactory,
      { current: () => ({ tenantId: '1' }) } as RequestContext,
      {} as SystemFieldCatalog,
    );
    await expect(source.loadFieldDefaults('2')).rejects.toThrow('上下文不一致');
    await expect(source.loadRoleFields('2')).rejects.toThrow('上下文不一致');
    expect(repos.for).not.toHaveBeenCalled();
  });
  it('旧配置指向已移除或禁止配置字段时，不继续覆盖代码', async () => {
    const query = {
      where: () => query,
      getMany: async () => [
        { resource: 'demo:user', field: 'removed', state: 'editable' },
        {
          resource: 'demo:user',
          field: 'phone',
          state: 'masked',
          mask: 'phone',
        },
      ],
    };
    const source = new SystemFieldSource(
      {
        for: () => ({ query: () => query }),
      } as unknown as TenantRepositoryFactory,
      { current: () => ({ tenantId: '1' }) } as RequestContext,
      {
        find: (_r: string, field: string) =>
          field === 'phone' ? {} : undefined,
      } as SystemFieldCatalog,
    );
    expect(await source.loadFieldDefaults('1')).toEqual([
      { resource: 'demo:user', field: 'phone', state: 'masked', mask: 'phone' },
    ]);
  });
});
