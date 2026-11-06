import {
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type Type,
} from '@nestjs/common';
import { AdminAuth } from '../endpoint/endpoint-auth.js';
import { AuthEvents } from './auth-events.js';
import { AuthUserStore, UnconfiguredAuthUserStore } from './auth-user.store.js';
import { AuthService } from './auth.service.js';
import { SvgCaptcha } from './captcha/svg.captcha.js';
import { CaptchaProvider } from './captcha/captcha.provider.js';
import { AuthController } from './controller/admin/auth.controller.js';
import { SessionController } from './controller/admin/session.controller.js';
import { LoginAttempts } from './login-attempts.service.js';
import { SessionAdminAuth } from './session-admin-auth.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

export interface AuthModuleOptions {
  /** 用户和组织的读取实现，system 模块（T07）提供；不传时用「没有账号」的默认实现（生产环境启动失败） */
  userStore?: Type<AuthUserStore>;
  /** 登录日志（T08）、通知接入时替换 */
  events?: Type<AuthEvents>;
  /** userStore / events 依赖的模块 */
  imports?: ModuleMetadata['imports'];
}

/**
 * 后台登录认证（T05）：人机验证、账号密码登录、双令牌、刷新轮换、退出与踢人、失败锁定、切换组织。
 * 在 AppModule 里 `AuthModule.forRoot({ userStore: ..., imports: [SystemModule] })`。
 */
@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions = {}): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      imports: options.imports ?? [],
      controllers: [AuthController, SessionController],
      providers: [
        TokenService,
        SessionService,
        LoginAttempts,
        AuthService,
        { provide: AuthEvents, useClass: options.events ?? AuthEvents },
        { provide: CaptchaProvider, useClass: SvgCaptcha },
        {
          provide: AuthUserStore,
          useClass: options.userStore ?? UnconfiguredAuthUserStore,
        },
        { provide: AdminAuth, useClass: SessionAdminAuth },
      ],
      exports: [
        AdminAuth,
        SessionService,
        TokenService,
        CaptchaProvider,
        AuthUserStore,
        AuthEvents,
      ],
    };
  }
}
