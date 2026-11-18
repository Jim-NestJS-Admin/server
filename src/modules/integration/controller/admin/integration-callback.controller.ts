import { Get, Post, Query, Req, Header, HttpCode } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';
import type { Request } from 'express';
import {
  AdminController,
  Anonymous,
} from '../../../../core/endpoint/endpoint.decorators.js';
import { RawResponse } from '../../../../core/decorators/raw-response.decorator.js';
import { crudErrors } from '../../../../core/crud/crud.errors.js';
import { IntegrationCallbackService } from '../../service/integration-callback.service.js';

class CallbackQuery {
  @Matches(/^[a-f0-9]{40}$/i) msg_signature!: string;
  @Matches(/^\d{10,11}$/) timestamp!: string;
  @IsString() @Length(1, 200) nonce!: string;
}
class CallbackVerifyQuery extends CallbackQuery {
  @IsString() @Length(1, 10000) echostr!: string;
}
/** 平台尚无后台令牌，先按平台协议验签解密，再入箱；不凭用户ID建立身份。 */
@Anonymous()
@AdminController('integration/callback')
@ApiExcludeController()
export class IntegrationCallbackController {
  constructor(private readonly callbacks: IntegrationCallbackService) {}
  @Get()
  @RawResponse()
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async verify(@Query() query: CallbackVerifyQuery) {
    return (await this.callbacks.decode(query, query.echostr)).plaintext;
  }
  @Post()
  @HttpCode(200)
  @RawResponse()
  @Header('Content-Type', 'text/plain; charset=utf-8')
  receive(@Query() query: CallbackQuery, @Req() req: Request) {
    if (typeof req.body !== 'string')
      throw crudErrors.badRequest('回调必须使用XML请求体');
    return this.callbacks.receive(query, req.body);
  }
}
