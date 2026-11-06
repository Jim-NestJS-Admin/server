import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PLATFORM_TENANT_ID, TENANT_ID_PATTERN } from './tenant.constants.js';

/** 请求来自哪个端（架构「整体架构」：/admin、/app、/web、/open） */
export type EndpointKind = 'admin' | 'app' | 'web' | 'open';

/** 认证守卫确认过的身份：只能来自令牌、会话或 API Key，不能来自请求体 */
export interface Principal {
  tenantId: string;
  userId: string | null;
  /** 当前组织（T06 用来取本次有效角色） */
  orgId: string | null;
}

export interface ContextSnapshot extends Principal {
  endpoint: EndpointKind | 'system';
  /** 平台管理员的 @IgnoreTenant 接口：本次请求跨租户查询 */
  ignoreTenant: boolean;
}

const KEY = 'jna:context';

export class MissingContextError extends Error {
  constructor() {
    super(
      '没有租户上下文：请求要先经过认证守卫；后台任务、脚本要用 RequestContext.run 指定租户',
    );
  }
}

/**
 * 请求上下文：租户、当前用户、当前组织、所属端。
 * - HTTP 请求由端的认证守卫写入（EndpointGuard）；
 * - 后台任务、消息消费、脚本用 run() 显式指定，不能靠默认值；
 * - 没有上下文时读取直接报错，不会悄悄落到某个默认租户上。
 */
@Injectable()
export class RequestContext {
  constructor(private readonly cls: ClsService) {}

  /** 认证守卫调用：写入本次请求的身份，同一请求只能写一次 */
  establish(endpoint: EndpointKind, principal: Principal): void {
    if (!this.cls.isActive()) throw new MissingContextError();
    if (this.cls.get(KEY)) throw new Error('本次请求的身份已经确定，不能再改');
    this.cls.set(KEY, this.snapshot(endpoint, principal));
  }

  /** 平台管理员的跨租户接口：只有平台租户能打开 */
  allowCrossTenant(): void {
    const ctx = this.current();
    if (ctx.tenantId !== PLATFORM_TENANT_ID)
      throw new Error('只有平台管理员可以跨租户查询');
    this.cls.set(KEY, { ...ctx, ignoreTenant: true });
  }

  /** 后台任务、脚本：在指定租户下执行一段代码 */
  async run<R>(
    principal: Partial<Principal> & { tenantId: string },
    fn: () => Promise<R>,
  ): Promise<R> {
    const snap = this.snapshot('system', {
      tenantId: principal.tenantId,
      userId: principal.userId ?? null,
      orgId: principal.orgId ?? null,
    });
    return this.cls.run(async () => {
      this.cls.set(KEY, snap);
      return fn();
    });
  }

  current(): ContextSnapshot {
    const ctx = this.cls.isActive()
      ? this.cls.get<ContextSnapshot | undefined>(KEY)
      : undefined;
    if (!ctx) throw new MissingContextError();
    return ctx;
  }

  /** 有没有上下文（日志、异常处理这类不能抛错的地方用） */
  peek(): ContextSnapshot | undefined {
    return this.cls.isActive()
      ? this.cls.get<ContextSnapshot | undefined>(KEY)
      : undefined;
  }

  private snapshot(
    endpoint: ContextSnapshot['endpoint'],
    p: Principal,
  ): ContextSnapshot {
    if (typeof p.tenantId !== 'string' || !TENANT_ID_PATTERN.test(p.tenantId))
      throw new Error(`租户编号格式不正确：${String(p.tenantId)}`);
    for (const [k, v] of [
      ['userId', p.userId],
      ['orgId', p.orgId],
    ] as const)
      if (v !== null && !(typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v)))
        throw new Error(`${k} 格式不正确`);
    return Object.freeze({
      endpoint,
      tenantId: p.tenantId,
      userId: p.userId,
      orgId: p.orgId,
      ignoreTenant: false,
    });
  }
}
