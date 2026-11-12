import { Injectable } from '@nestjs/common';
import { DEFAULT_TENANT_ID, PLATFORM_TENANT_ID } from './tenant.constants.js';

/** 租户的基本信息（契约 tenant.md 第 3 节） */
export interface TenantInfo {
  /** 就是业务数据里的 tenant_id */
  id: string;
  code: string;
  name: string;
  /** 已按到期时间算过：停用或过期都是 false */
  enabled: boolean;
  /** 套餐；平台为 null */
  packageId: string | null;
}

/** 平台编码固定为 platform，登录页填它进入平台 */
export const PLATFORM_TENANT_CODE = 'platform';
export const DEFAULT_TENANT_CODE = 'default';

/**
 * 租户目录：core 不认识租户表，由租户模块（T31）实现后在 TenantCoreModule.forRoot({ source }) 里替换。
 * 实现方要自己缓存，并在租户 / 套餐修改后清掉缓存：认证守卫每个请求都会调 byId 核对租户状态。
 */
export abstract class TenantSource {
  /** 按请求主机名（小写，可带端口）找租户；没绑定返回 null */
  abstract byDomain(host: string): Promise<TenantInfo | null>;
  /** 按租户编码找；platform 返回平台（id 0） */
  abstract byCode(code: string): Promise<TenantInfo | null>;
  abstract byId(id: string): Promise<TenantInfo | null>;
  /**
   * 租户套餐里可用的菜单 id；返回 null 表示不限（全部租户可用菜单）。平台不调用。
   * 套餐或租户的套餐变化后，实现方要调 PermissionService.bumpVersion(tenantId)。
   */
  abstract packageMenuIds(tenantId: string): Promise<string[] | null>;
}

const PLATFORM: TenantInfo = Object.freeze({
  id: PLATFORM_TENANT_ID,
  code: PLATFORM_TENANT_CODE,
  name: '平台',
  enabled: true,
  packageId: null,
});
const DEFAULT: TenantInfo = Object.freeze({
  id: DEFAULT_TENANT_ID,
  code: DEFAULT_TENANT_CODE,
  name: '默认租户',
  enabled: true,
  packageId: null,
});

/** 租户模块接入之前的内置实现：只有平台和默认租户，没有域名绑定，套餐不限 */
@Injectable()
export class BuiltinTenantSource extends TenantSource {
  async byDomain(_host: string): Promise<TenantInfo | null> {
    return null;
  }
  async byCode(code: string): Promise<TenantInfo | null> {
    return [PLATFORM, DEFAULT].find((t) => t.code === code) ?? null;
  }
  async byId(id: string): Promise<TenantInfo | null> {
    return [PLATFORM, DEFAULT].find((t) => t.id === id) ?? null;
  }
  async packageMenuIds(_tenantId: string): Promise<string[] | null> {
    return null;
  }
}
