import { Body, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  AdminController,
  Anonymous,
} from '../../../../core/endpoint/endpoint.decorators.js';
import { AppConfigService } from '../../../../core/config/app-config.service.js';
import {
  assertAdminOrigin,
  setRefreshCookie,
} from '../../../../core/auth/http.js';
import { TokenResult } from '../../../../core/auth/dto/auth.dto.js';
import { RateLimit } from '../../../../core/security/rate-limit.js';
import { ApiResult } from '../../../../core/swagger/api-result.js';
import {
  IntegrationLoginBody,
  IntegrationLoginStartBody,
  IntegrationLoginStartResult,
} from '../../dto/integration.dto.js';
import { IntegrationLoginService } from '../../service/integration-login.service.js';

/** 登录握手尚无后台会话；租户仍由统一匿名入口解析。 */
@Anonymous()
@AdminController('integration/login')
export class IntegrationLoginController {
  constructor(
    private readonly login: IntegrationLoginService,
    private readonly config: AppConfigService,
  ) {}
  @Post('start')
  @HttpCode(200)
  @RateLimit('login', 20, 60)
  @ApiOperation({
    operationId: 'integrationLoginStart',
    summary: '生成一次性扫码或免登授权地址',
  })
  @ApiResult(IntegrationLoginStartResult)
  async start(
    @Body() body: IntegrationLoginStartBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertAdminOrigin(req, this.config.auth.adminOrigins);
    const result = await this.login.start(body.desktop, body.returnPath);
    res.cookie('jna_wecom_state', result.browser, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/admin/integration/login',
      maxAge: 300000,
    });
    return result.body;
  }
  @Post('exchange')
  @HttpCode(200)
  @RateLimit('login', 20, 60)
  @ApiOperation({
    operationId: 'integrationLoginExchange',
    summary: '一次性授权码登录已同步的企业成员',
  })
  @ApiResult(TokenResult)
  async exchange(
    @Body() body: IntegrationLoginBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertAdminOrigin(req, this.config.auth.adminOrigins);
    const cookie = req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('jna_wecom_state='))
      ?.slice('jna_wecom_state='.length);
    const result = await this.login.login(
      body.state,
      body.code,
      cookie,
      req.ip ?? '',
      req.headers['user-agent'] ?? '',
    );
    res.clearCookie('jna_wecom_state', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/admin/integration/login',
    });
    setRefreshCookie(
      res,
      result.refreshToken,
      this.config.auth.refreshTtlSeconds,
    );
    return result.body;
  }
}
