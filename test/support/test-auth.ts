import { HttpStatus, Injectable, type ModuleMetadata } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { AdminAuth } from '../../src/core/endpoint/endpoint-auth.js';
import { BusinessException } from '../../src/core/exceptions/business.exception.js';
import { ErrorCode } from '../../src/core/exceptions/error-code.js';
import type { Principal } from '../../src/core/tenant/request-context.js';
import { DEFAULT_TENANT_ID } from '../../src/core/tenant/tenant.constants.js';
import {
  TenantSource,
  BuiltinTenantSource,
} from '../../src/core/tenant/tenant-source.js';
import { TenantQuotaService } from '../../src/modules/tenant/service/tenant-quota.service.js';
import {
  PermissionSource,
  type RoleGrant,
} from '../../src/core/permission/permission-source.js';

/**
 * 测试用后台认证：不走登录，从请求头取身份。CRUD、租户这类测试关心的不是登录，用它代替正式认证：
 * `.overrideProvider(AdminAuth).useClass(TestAdminAuth)`。
 * - x-test-tenant：租户，不带时是默认租户；带 x-test-anon: 1 表示没登录（401）
 * - x-test-user / x-test-org：当前用户（不带时是 1）、当前组织（不带时为空）
 * 权限用 AllowAllPermissionSource：每个用户都是全局超级管理员、数据范围全部。权限本身的测试（permission.e2e-spec）用自己的来源。
 * 登录本身的测试（auth.e2e-spec）用正式实现。
 */
@Injectable()
export class TestAdminAuth extends AdminAuth {
  async resolveTenant(): Promise<string> {
    return DEFAULT_TENANT_ID;
  }

  async authenticate(req: Request): Promise<Principal> {
    if (req.header('x-test-anon'))
      throw new BusinessException(
        ErrorCode.Unauthorized,
        '请先登录',
        HttpStatus.UNAUTHORIZED,
      );
    return {
      tenantId: req.header('x-test-tenant') ?? DEFAULT_TENANT_ID,
      userId: req.header('x-test-user') ?? '1',
      orgId: req.header('x-test-org') ?? null,
    };
  }
}

/** 测试用权限来源：所有人都是全局超级管理员、数据范围全部 */
@Injectable()
export class AllowAllPermissionSource extends PermissionSource {
  async loadGrants(): Promise<RoleGrant[]> {
    return [
      {
        roleId: 'test-admin',
        scopeOrgId: null,
        permissions: [],
        allPermissions: true,
        dataScope: 'all',
      },
    ];
  }
  async loadOrgs() {
    return [];
  }
  async loadMenus() {
    return [];
  }
}

/** Test.createTestingModule，并换上测试用后台认证和权限来源 */
export const createTestModule = (metadata: ModuleMetadata) =>
  Test.createTestingModule(metadata)
    .overrideProvider(AdminAuth)
    .useClass(TestAdminAuth)
    // 旧资源测试使用身份头而非真实目录/套餐；T31/T32真实租户套件不使用这些替换。
    .overrideProvider(TenantSource)
    .useClass(BuiltinTenantSource)
    .overrideProvider(TenantQuotaService)
    .useValue({
      assertCanAddUser: async () => undefined,
      assertStorage: async () => undefined,
    })
    .overrideProvider(PermissionSource)
    .useClass(AllowAllPermissionSource);
