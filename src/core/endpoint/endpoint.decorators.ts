import { applyDecorators, Controller, SetMetadata } from '@nestjs/common';
import type { EndpointKind } from '../tenant/request-context.js';

export const ENDPOINT_KEY = 'jna:endpoint';
export const PUBLIC_KEY = 'jna:public';
export const IGNORE_TENANT_KEY = 'jna:ignore-tenant';

/** 各端的路由前缀，控制器放在 controller/{admin,app,web,open}/ 目录下 */
export const ENDPOINT_PREFIX: Record<EndpointKind, string> = {
  admin: 'admin',
  app: 'app',
  web: 'web',
  open: 'open',
};

const endpointController = (kind: EndpointKind) => (path: string) =>
  applyDecorators(
    SetMetadata(ENDPOINT_KEY, kind),
    Controller(`${ENDPOINT_PREFIX[kind]}/${path.replace(/^\/+/, '')}`),
  );

/** 后台端接口：/admin/<path>，后台用户登录（T05） */
export const AdminController = endpointController('admin');
/** APP / 小程序端：/app/<path>，会员登录（阶段 4） */
export const AppController = endpointController('app');
/** 网站端：/web/<path>，会员登录（阶段 2） */
export const WebController = endpointController('web');
/** 开放端：/open/<path>，API Key 或 OAuth2（阶段 3） */
export const OpenController = endpointController('open');

/**
 * 不属于任何端、也不需要身份的基础接口（健康检查这类）。只能加在控制器上，
 * 业务接口不能用它绕开认证：每个控制器必须属于一个端或者明确标成 Public，启动时检查。
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * 平台管理员接口跨租户查询（架构「多租户设计 · 显式越权」）。
 * 只有平台租户（0）的请求能用，其他租户访问返回 403；每次使用都记日志。
 */
export const IgnoreTenant = () => SetMetadata(IGNORE_TENANT_KEY, true);
