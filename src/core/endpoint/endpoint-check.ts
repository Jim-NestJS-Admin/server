import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants.js';
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
      const raw = Reflect.getMetadata(PATH_METADATA, cls) as
        string | string[] | undefined;
      const paths = (Array.isArray(raw) ? raw : [raw ?? '']).map((p) =>
        p.replace(/^\/+/, ''),
      );
      if (isPublic && endpoint)
        throw new Error(`${name} 不能同时属于端 ${endpoint} 又标成 @Public`);
      if (!isPublic && !endpoint)
        throw new Error(
          `${name} 没有指定所属的端：用 @AdminController 等代替 @Controller，基础接口才用 @Public`,
        );
      if (isPublic) {
        for (const p of paths)
          for (const prefix of Object.values(ENDPOINT_PREFIX))
            if (p === prefix || p.startsWith(`${prefix}/`))
              throw new Error(`${name} 是 @Public，路径不能在 /${prefix} 下`);
        const proto = cls.prototype as Record<string, unknown>;
        for (const key of Object.getOwnPropertyNames(proto))
          if (
            typeof proto[key] === 'function' &&
            Reflect.getMetadata(IGNORE_TENANT_KEY, proto[key] as object)
          )
            throw new Error(
              `${name}.${key} 是 @Public 接口，不能用 @IgnoreTenant`,
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
