import { Body, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AppConfigService } from '../../../config/app-config.service.js';
import { AdminController } from '../../../endpoint/endpoint.decorators.js';
import { LoginOnly } from '../../../permission/perms.decorator.js';
import { ApiErrors, ApiResult } from '../../../swagger/api-result.js';
import { AuthService } from '../../auth.service.js';
import {
  ProfileResult,
  SwitchOrgDto,
  TokenResult,
} from '../../dto/auth.dto.js';
import {
  assertAdminOrigin,
  setRefreshCookie,
  unauthorized,
  type AuthedRequest,
} from '../../http.js';

/** 当前登录用户：个人信息、当前组织、切换组织。菜单和权限（sessionMenu）在 permission 的 MenuController */
@ApiTags('auth 登录认证')
@ApiBearerAuth()
// 当前组织失效（被移出、角色收回）时也要能看个人信息、切到别的组织
@LoginOnly({ orgCheck: false })
@AdminController('session')
export class SessionController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  @Get('profile')
  @ApiOperation({
    operationId: 'sessionProfile',
    summary: '当前用户、当前组织、可切换的组织',
  })
  @ApiResult(ProfileResult)
  @ApiErrors(401, 503)
  profile(): Promise<ProfileResult> {
    return this.auth.profile();
  }

  @Post('switch-org')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'sessionSwitchOrg',
    summary: '切换当前组织',
    description:
      '返回带新组织的访问令牌，同时换刷新令牌 Cookie；旧访问令牌立即失效',
  })
  @ApiResult(TokenResult)
  @ApiErrors(400, 401, 403, 503)
  async switchOrg(
    @Body() dto: SwitchOrgDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResult> {
    assertAdminOrigin(req, this.config.auth.adminOrigins);
    const sessionId = req.jnaSession?.sessionId;
    if (!sessionId) throw unauthorized();
    const out = await this.auth.switchOrg(sessionId, dto.orgId);
    setRefreshCookie(res, out.refreshToken, this.auth.refreshTtlSeconds);
    return out.body;
  }
}
