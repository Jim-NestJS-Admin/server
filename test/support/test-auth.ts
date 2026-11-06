import { HttpStatus, Injectable, type ModuleMetadata } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { AdminAuth } from '../../src/core/endpoint/endpoint-auth.js';
import { BusinessException } from '../../src/core/exceptions/business.exception.js';
import { ErrorCode } from '../../src/core/exceptions/error-code.js';
import type { Principal } from '../../src/core/tenant/request-context.js';
import { DEFAULT_TENANT_ID } from '../../src/core/tenant/tenant.constants.js';

/**
 * 测试用后台认证：不走登录，从请求头取身份。CRUD、租户这类测试关心的不是登录，用它代替正式认证：
 * `.overrideProvider(AdminAuth).useClass(TestAdminAuth)`。
 * - x-test-tenant：租户，不带时是默认租户；带 x-test-anon: 1 表示没登录（401）
 * - x-test-user / x-test-org：当前用户、组织，不带时为空
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
      userId: req.header('x-test-user') ?? null,
      orgId: req.header('x-test-org') ?? null,
    };
  }
}

/** Test.createTestingModule，并换上测试用后台认证 */
export const createTestModule = (metadata: ModuleMetadata) =>
  Test.createTestingModule(metadata)
    .overrideProvider(AdminAuth)
    .useClass(TestAdminAuth);
