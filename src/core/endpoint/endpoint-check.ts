import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants.js';

// Express 默认路由不区分大小写：比较前一律转小写，否则 @Public 的 'AdMiN/x' 能绕过前缀检查
const trim = (p: string) => p.replace(/^\/+|\/+$/g, '').toLowerCase();
const asList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v ?? '']).map((p) => trim(String(p)));

/** 控制器上的路由方法（含继承来的），返回方法名和拼好的完整路径 */
function routes(
  cls: Function,
  base: string[],
): { method: string; fn: object; paths: string[] }[] {
  const out: { method: string; fn: object; paths: string[] }[] = [];
  const seen = new Set<string>();
  for (
    let proto = cls.prototype as object | null;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  )
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || seen.has(key)) continue;
      seen.add(key);
      const fn = (proto as Record<string, unknown>)[key];
      if (typeof fn !== 'function') continue;
      const own = Reflect.getMetadata(PATH_METADATA, fn) as unknown;
      if (own === undefined) continue;
      const paths = base.flatMap((b) =>
        asList(own).map((m) => trim([b, m].filter(Boolean).join('/'))),
      );
      out.push({ method: key, fn, paths });
    }
  return out;
}
import {
  ENDPOINT_KEY,
  ENDPOINT_PREFIX,
  IGNORE_TENANT_KEY,
  PUBLIC_KEY,
} from './endpoint.decorators.js';
import type { EndpointKind } from '../tenant/request-context.js';

/** 阶段 1 已经接入认证的端 */
const ENABLED: EndpointKind[] = ['admin'];

/**
 * 启动检查：每个控制器都必须属于一个端（@AdminController 等）或者明确是 @Public 的基础接口，
 * 路径前缀和端一致，所属的端已经接入认证。写错直接启动失败，不会有漏掉认证的接口上线。
 */
@Injectable()
export class EndpointCheck implements OnModuleInit {
  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getControllers()) {
      const cls = wrapper.metatype as Function | null;
      if (!cls) continue;
      const name = cls.name;
      const isPublic = Reflect.getMetadata(PUBLIC_KEY, cls) === true;
      const endpoint = Reflect.getMetadata(ENDPOINT_KEY, cls) as
        EndpointKind | undefined;
      const base = asList(Reflect.getMetadata(PATH_METADATA, cls) as unknown);
      const list = routes(cls, base);
      for (const r of list)
        if (Reflect.getMetadata(PUBLIC_KEY, r.fn) === true)
          throw new Error(
            `${name}.${r.method} 上加了 @Public：@Public 只能加在控制器上，不能在某个端的控制器里开免登录的方法`,
          );
      if (isPublic && endpoint)
        throw new Error(`${name} 不能同时属于端 ${endpoint} 又标成 @Public`);
      if (!isPublic && !endpoint)
        throw new Error(
          `${name} 没有指定所属的端：用 @AdminController 等代替 @Controller，基础接口才用 @Public`,
        );
      const paths = [...base, ...list.flatMap((r) => r.paths)];
      if (isPublic) {
        // 按拼好的完整路径检查：@Controller('') 加 @Get('admin/x') 也算在 /admin 下
        for (const p of paths)
          for (const prefix of Object.values(ENDPOINT_PREFIX))
            if (p === prefix || p.startsWith(`${prefix}/`))
              throw new Error(
                `${name} 是 @Public，路径 /${p} 不能在 /${prefix} 下`,
              );
        for (const r of list)
          if (Reflect.getMetadata(IGNORE_TENANT_KEY, r.fn))
            throw new Error(
              `${name}.${r.method} 是 @Public 接口，不能用 @IgnoreTenant`,
            );
        continue;
      }
      const prefix = ENDPOINT_PREFIX[endpoint!];
      for (const p of paths)
        if (p !== prefix && !p.startsWith(`${prefix}/`))
          throw new Error(
            `${name} 属于 ${endpoint} 端，路径必须以 /${prefix}/ 开头`,
          );
      if (!ENABLED.includes(endpoint!))
        throw new Error(
          `${name} 属于 ${endpoint} 端，这个端还没有接入认证，不能注册`,
        );
    }
  }
}
