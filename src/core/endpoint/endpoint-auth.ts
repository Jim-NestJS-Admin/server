import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../config/app-config.service.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenant.constants.js';
import type { Principal } from '../tenant/request-context.js';

/**
 * 后台端认证：从请求里取令牌、每次核对会话，返回可信身份；不通过就抛 401 / 403。
 * T05 提供正式实现并替换下面的阶段 1 占位实现。
 */
export abstract class AdminAuth {
  abstract authenticate(req: Request): Promise<Principal>;
}

/**
 * 阶段 1 占位：登录（T05）接入之前，后台请求一律当作默认租户的匿名用户。
 * 只为了让 T03 / T04 的接口能在开发和测试里跑起来；生产环境启动时直接拒绝，不能带着它上线。
 */
@Injectable()
export class PhaseOneAdminAuth extends AdminAuth implements OnModuleInit {
  constructor(private readonly config: AppConfigService) {
    super();
  }

  onModuleInit(): void {
    if (this.config.isProduction)
      throw new Error(
        '后台认证还没有接入（T05），生产环境不能启动：请替换 AdminAuth 的实现',
      );
  }

  async authenticate(): Promise<Principal> {
    return { tenantId: DEFAULT_TENANT_ID, userId: null, orgId: null };
  }
}
