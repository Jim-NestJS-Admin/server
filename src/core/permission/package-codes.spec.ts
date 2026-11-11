import type { AuthzContext } from './authz-context.js';
import type { FieldPermSource } from '../field-perm/field-perm-source.js';
import type { RedisService } from '../redis/redis.service.js';
import type { RequestContext } from '../tenant/request-context.js';
import { TenantSource, type TenantInfo } from '../tenant/tenant-source.js';
import type { PermissionRegistry } from './permission-registry.js';
import type { MenuNode, PermissionSource } from './permission-source.js';
import { PermissionService } from './permission.service.js';

const menu = (id: string, permission: string | null): MenuNode => ({
  id,
  parentId: null,
  type: 'button',
  path: '/' + id,
  title: id,
  rank: 0,
  permission,
});
const menus = [
  menu('1', 'system:user:page'),
  menu('2', 'system:user:add'),
  menu('3', 'system:role:page'),
  menu('4', 'platform:tenant:page'),
  menu('5', null),
];

class PackageSource extends TenantSource {
  constructor(private readonly ids: string[] | null) {
    super();
  }
  async byDomain(): Promise<TenantInfo | null> {
    return null;
  }
  async byCode(): Promise<TenantInfo | null> {
    return null;
  }
  async byId(): Promise<TenantInfo | null> {
    return null;
  }
  async packageMenuIds(): Promise<string[] | null> {
    return this.ids;
  }
}

const service = (tenants?: TenantSource) =>
  new PermissionService(
    {} as RedisService,
    { loadMenus: async () => menus } as unknown as PermissionSource,
    {
      all: () => [{ code: 'system:user:page' }, { code: 'session:menu' }],
    } as unknown as PermissionRegistry,
    {} as RequestContext,
    {} as AuthzContext,
    {} as FieldPermSource,
    tenants,
  );

describe('套餐范围内的权限码 packageCodes', () => {
  it('只含套餐里菜单上的权限码，platform:* 永远不在里面', async () => {
    const codes = await service(
      new PackageSource(['1', '3', '4']),
    ).packageCodes('7');
    expect(codes).toEqual(['system:role:page', 'system:user:page']);
  });

  it('套餐不限时是全部租户权限码，仍不含 platform:*', async () => {
    const codes = await service(new PackageSource(null)).packageCodes('7');
    expect(codes).toEqual([
      'session:menu',
      'system:role:page',
      'system:user:add',
      'system:user:page',
    ]);
  });

  it('平台租户拥有全部权限码；没装租户模块时按内置目录（套餐不限）', async () => {
    expect(await service().packageCodes('0')).toContain('platform:tenant:page');
    expect(await service().packageCodes('1')).not.toContain(
      'platform:tenant:page',
    );
  });
});
