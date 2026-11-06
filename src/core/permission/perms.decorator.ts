import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

export const PERMS_KEY = 'jna:perms';
export const LOGIN_ONLY_KEY = 'jna:login-only';

/** 风险级别：high 的操作通过 MCP 调用时要在后台确认（架构「MCP 服务 · 默认必须确认的操作」） */
export type PermRisk = 'normal' | 'high';

export interface PermMeta {
  code: string;
  risk: PermRisk;
}

const CODE = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/;

/**
 * 接口需要的权限码（架构「功能权限」）：`@Perms('cms:content:publish', { risk: 'high' })`。
 * 一个接口一个权限码；通用 CRUD 的接口按「前缀:动作」自动加，不用写。
 * 权限码会写进接口文档（x-permission），前端据此生成常量。
 */
export function Perms(
  code: string,
  options: { risk?: PermRisk } = {},
): MethodDecorator {
  if (!CODE.test(code))
    throw new Error(
      `权限码 ${code} 格式不对：小写字母开头，用冒号分段，例如 system:user:add`,
    );
  const meta: PermMeta = { code, risk: options.risk ?? 'normal' };
  return applyDecorators(
    SetMetadata(PERMS_KEY, meta),
    ApiExtension('x-permission', meta),
  );
}

export interface LoginOnlyMeta {
  /** 核对用户在当前组织里还有角色（默认 true） */
  orgCheck: boolean;
}

/**
 * 登录就能用、不需要权限码的后台接口（当前用户信息、菜单、切换组织这类）。可以加在控制器或方法上。
 * 后台接口必须二选一：@Perms 或 @LoginOnly，都没有启动时报错。
 * orgCheck: false 只给「当前组织已经失效时也要能用」的接口（个人信息、切换组织）。
 */
export const LoginOnly = (options: { orgCheck?: boolean } = {}) =>
  SetMetadata(LOGIN_ONLY_KEY, {
    orgCheck: options.orgCheck ?? true,
  } satisfies LoginOnlyMeta);
