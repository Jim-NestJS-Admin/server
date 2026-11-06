import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';

/** 登录时需要的账号信息 */
export interface AuthUser {
  id: string;
  /** bcrypt 哈希 */
  passwordHash: string;
  /** 停用的账号一律按「账号或密码错误」处理 */
  enabled: boolean;
  /** 登录后默认进入的组织；为空或不在可切换列表里时取列表第一个 */
  defaultOrgId: string | null;
}

export interface AuthOrg {
  id: string;
  name: string;
  /** 从根到自己的名称，例如 ['集团', '澳洲站'] */
  path: string[];
}

export interface AuthProfile {
  id: string;
  username: string;
  nickname: string;
  avatar: string | null;
  enabled: boolean;
  /** 界面语言，没有设置时用 zh-CN */
  locale?: string | null;
}

/**
 * 认证读取用户和组织的接口，由 system 模块（T07）实现并提供：
 * `{ provide: AuthUserStore, useClass: SystemAuthUserStore }`。
 *
 * 实现方的义务（否则「改密、停用后旧令牌立即失效」不成立）：
 * 改密码、管理员重置密码、停用账号、删除账号时，调用 SessionService.revokeUser(tenantId, userId)。
 * 用户被移出某个组织或收回该组织下全部角色时，权限守卫（T06）每次请求都会核对组织归属。
 */
export abstract class AuthUserStore {
  /** username 已经规范化（去首尾空格、转小写），按租户 + 规范化账号查 */
  abstract findForLogin(
    tenantId: string,
    username: string,
  ): Promise<AuthUser | null>;
  abstract findProfile(
    tenantId: string,
    userId: string,
  ): Promise<AuthProfile | null>;
  /** 用户在里面有角色的组织（可切换的组织），按显示顺序 */
  abstract listOrgs(tenantId: string, userId: string): Promise<AuthOrg[]>;
}

/**
 * system 模块（T07）接入之前的默认实现：没有任何账号，登录一律失败。
 * 生产环境启动时直接拒绝，不能带着它上线。
 */
@Injectable()
export class UnconfiguredAuthUserStore
  extends AuthUserStore
  implements OnModuleInit
{
  private readonly logger = new Logger('AuthUserStore');

  constructor(private readonly config: AppConfigService) {
    super();
  }

  onModuleInit(): void {
    if (this.config.isProduction && !this.config.openApiExport)
      throw new Error(
        '用户模块（T07）还没有接入登录，生产环境不能启动：请提供 AuthUserStore 的实现',
      );
    this.logger.warn(
      '用户模块还没有接入登录（AuthUserStore），所有登录都会失败',
    );
  }

  async findForLogin(): Promise<AuthUser | null> {
    return null;
  }
  async findProfile(): Promise<AuthProfile | null> {
    return null;
  }
  async listOrgs(): Promise<AuthOrg[]> {
    return [];
  }
}
