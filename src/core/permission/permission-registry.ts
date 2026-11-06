import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { PERMS_KEY, type PermMeta } from './perms.decorator.js';

/**
 * 后端声明过的全部权限码（@Perms 和通用 CRUD 自动生成的）。超级管理员的权限码列表、
 * 以后的 seed 生成按钮菜单、MCP 按风险级别判断确认，都从这里取。
 */
@Injectable()
export class PermissionRegistry implements OnApplicationBootstrap {
  private readonly codes = new Map<string, PermMeta>();

  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getControllers()) {
      const cls = wrapper.metatype as Function | null;
      if (!cls) continue;
      for (
        let proto = cls.prototype as object | null;
        proto && proto !== Object.prototype;
        proto = Object.getPrototypeOf(proto) as object | null
      )
        for (const key of Object.getOwnPropertyNames(proto)) {
          const fn = (proto as Record<string, unknown>)[key];
          if (typeof fn !== 'function') continue;
          const meta = Reflect.getMetadata(PERMS_KEY, fn) as
            PermMeta | undefined;
          if (!meta) continue;
          const prev = this.codes.get(meta.code);
          if (prev && prev.risk !== meta.risk)
            throw new Error(
              `权限码 ${meta.code} 在不同接口上声明了不同的风险级别（${prev.risk} / ${meta.risk}）`,
            );
          this.codes.set(meta.code, meta);
        }
    }
  }

  all(): PermMeta[] {
    return [...this.codes.values()].sort((a, b) =>
      a.code.localeCompare(b.code),
    );
  }

  get(code: string): PermMeta | undefined {
    return this.codes.get(code);
  }
}
