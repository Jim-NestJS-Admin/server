import { Body, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppConfigService } from '../../../config/app-config.service.js';
import {
  AdminController,
  Anonymous,
} from '../../../endpoint/endpoint.decorators.js';
import { ApiErrors, ApiResult } from '../../../swagger/api-result.js';
import { AuthService } from '../../auth.service.js';
import {
  CaptchaQueryDto,
  CaptchaResultDto,
  LoginDto,
  TokenResult,
} from '../../dto/auth.dto.js';
import {
  assertAdminOrigin,
  clearRefreshCookie,
  readBearer,
  readRefreshCookie,
  setRefreshCookie,
} from '../../http.js';
import { LoginLockedException } from '../../login-attempts.service.js';
import { TokenService } from '../../token.service.js';

/** 后台登录：出题、登录、刷新、退出。都不需要访问令牌（刷新和退出靠 Cookie） */
@ApiTags('auth 登录认证')
@Anonymous()
@AdminController('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly config: AppConfigService,
  ) {}

  @Get('captcha')
  @ApiOperation({
    operationId: 'authCaptcha',
    summary: '获取图形验证码',
    description:
      '字母数字验证码，2 分钟有效，只能用一次（答错也作废，要重新获取）；account 传用户输入的账号',
  })
  @ApiResult(CaptchaResultDto)
  @ApiErrors(400, 503)
  captcha(@Query() q: CaptchaQueryDto, @Req() req: Request) {
    return this.auth.createLoginChallenge(q.account, req);
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ operationId: 'authLogin', summary: '账号密码登录' })
  @ApiResult(TokenResult)
  @ApiErrors(400, 429, 503)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResult> {
    try {
      const out = await this.auth.login(dto, req);
      setRefreshCookie(res, out.refreshToken, this.auth.refreshTtlSeconds);
      return out.body;
    } catch (e) {
      if (e instanceof LoginLockedException)
        res.setHeader('Retry-After', String(e.retryAfterSeconds));
      throw e;
    }
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'authRefresh',
    summary: '刷新访问令牌',
    description:
      '靠 Cookie 里的刷新令牌，同时换新的刷新令牌。失败一律 401 并清 Cookie，不要重试',
  })
  @ApiResult(TokenResult)
  @ApiErrors(401, 403, 503)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResult> {
    assertAdminOrigin(req, this.config.auth.adminOrigins);
    try {
      const out = await this.auth.refresh(readRefreshCookie(req), req);
      setRefreshCookie(res, out.refreshToken, this.auth.refreshTtlSeconds);
      return out.body;
    } catch (e) {
      clearRefreshCookie(res);
      throw e;
    }
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'authLogout',
    summary: '退出',
    description:
      '有访问令牌就带上；吊销本会话并清 Cookie，会话本来就没了也返回成功',
  })
  @ApiResult()
  @ApiErrors(403, 503)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<null> {
    assertAdminOrigin(req, this.config.auth.adminOrigins);
    const bearer = readBearer(req);
    const claims = bearer ? await this.tokens.verify(bearer) : null;
    const fromCookie = await this.auth.sessionOfRefreshToken(
      readRefreshCookie(req),
    );
    await this.auth.logout([fromCookie, claims?.sessionId ?? null]);
    clearRefreshCookie(res);
    return null;
  }
}
