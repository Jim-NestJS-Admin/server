import { Injectable, Logger } from '@nestjs/common';

export type LoginFailReason = 'locked' | 'captcha' | 'credentials' | 'disabled';

export interface LoginEvent {
  tenantId: string;
  /** 规范化后的账号 */
  username: string;
  userId: string | null;
  ip: string;
  userAgent: string;
}

/**
 * 认证事件：登录成功 / 失败、退出、发现刷新令牌被重复使用。
 * 默认只写日志；登录日志（T08）和通知（notify）接入时替换实现：`{ provide: AuthEvents, useClass: ... }`。
 * 实现里不要抛错，失败自己记日志，不能影响登录本身。
 */
@Injectable()
export class AuthEvents {
  protected readonly logger = new Logger('Auth');

  async loginSucceeded(e: LoginEvent & { sessionId: string }): Promise<void> {
    this.logger.log({ event: 'auth.login', ...e });
  }

  async loginFailed(
    e: LoginEvent & { reason: LoginFailReason },
  ): Promise<void> {
    this.logger.warn({ event: 'auth.login-failed', ...e });
  }

  async loggedOut(e: {
    tenantId: string;
    userId: string;
    sessionId: string;
  }): Promise<void> {
    this.logger.log({ event: 'auth.logout', ...e });
  }

  /** 旧刷新令牌被再次使用：令牌可能被盗，这个会话已整体吊销。正式实现要通知用户和管理员 */
  async refreshReuseDetected(e: {
    tenantId: string;
    userId: string;
    sessionId: string;
    ip: string;
  }): Promise<void> {
    this.logger.warn({ event: 'auth.refresh-reuse', ...e });
  }
}
