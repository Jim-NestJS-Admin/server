import type { Request } from 'express';
import {
  DEFAULT_TENANT_ID,
  TENANT_CODE_HEADER,
  UNRESOLVED_TENANT_ID,
} from './tenant.constants.js';
import type { TenantInfo, TenantSource } from './tenant-source.js';

/** 请求的主机名（小写，带端口）；只有配置了受控代理时 Express 才会采用 X-Forwarded-Host */
export function requestHost(req: Request): string {
  return String(req.host || req.get('host') || '')
    .trim()
    .toLowerCase();
}

export type TenantHint =
  { mode: 'domain'; tenant: { code: string; name: string } } | { mode: 'code' };

/**
 * 后台租户识别（契约 tenant.md 第 4 节，Jimmy 确认「域名优先 + 租户编码」）。
 * 只给 core/auth 用；业务代码一律从 RequestContext 取租户。
 */
export class TenantResolver {
  constructor(private readonly tenants: TenantSource) {}

  /**
   * 免登录接口（出题、登录、刷新、退出）的租户：
   * 域名绑定了租户就用它（请求头带了不同的编码视为找不到）；
   * 没绑定就看 X-Tenant-Code，没带编码等同默认租户（单租户部署不用填）。
   * 找不到、停用、过期都落到 UNRESOLVED_TENANT_ID，后续登录统一按「账号或密码错误」失败。
   */
  async anonymous(req: Request): Promise<string> {
    const code = this.codeOf(req);
    const bound = await this.tenants.byDomain(requestHost(req));
    if (bound)
      return code && code !== bound.code ? UNRESOLVED_TENANT_ID : usable(bound);
    // 不带编码等同默认租户，但默认租户同样要核对可用（停用 / 过期 / 删除后不能再刷新）
    if (!code) return usable(await this.tenants.byId(DEFAULT_TENANT_ID));
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(code)) return UNRESOLVED_TENANT_ID;
    return usable(await this.tenants.byCode(code));
  }

  /**
   * 已登录请求：租户只认令牌里的；租户必须还能用，请求域名也不能绑定到别的租户。
   * 不通过返回 false，由认证守卫回 401。
   */
  async tokenAllowed(req: Request, tenantId: string): Promise<boolean> {
    const bound = await this.tenants.byDomain(requestHost(req));
    if (bound && bound.id !== tenantId) return false;
    const info = await this.tenants.byId(tenantId);
    return !!info?.enabled;
  }

  async hint(req: Request): Promise<TenantHint> {
    const bound = await this.tenants.byDomain(requestHost(req));
    return bound?.enabled
      ? { mode: 'domain', tenant: { code: bound.code, name: bound.name } }
      : { mode: 'code' };
  }

  private codeOf(req: Request): string {
    const raw = req.headers[TENANT_CODE_HEADER];
    return (Array.isArray(raw) ? raw[0] : (raw ?? '')).trim().toLowerCase();
  }
}

function usable(info: TenantInfo | null): string {
  return info?.enabled ? info.id : UNRESOLVED_TENANT_ID;
}
