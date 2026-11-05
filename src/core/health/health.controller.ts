import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { RawResponse } from '../decorators/raw-response.decorator.js';
import { HealthService } from './health.service.js';

/** 健康检查：给 Nginx、容器编排探活用，原样返回，不需要登录；任何一项检查失败返回 503 */
@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @RawResponse()
  async check(@Res({ passthrough: true }) res: Response) {
    const result = await this.health.run();
    if (result.status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
