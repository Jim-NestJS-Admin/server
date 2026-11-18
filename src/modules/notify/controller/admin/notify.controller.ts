import { Body, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOperation } from '@nestjs/swagger';
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { Perms } from '../../../../core/permission/perms.decorator.js';
import { ApiResult } from '../../../../core/swagger/api-result.js';
import { NotifyMessage } from '../../entity/notify.entity.js';
import { NotifyMessageService } from '../../service/notify.service.js';
import {
  NotifyReadBody,
  NotifyReadResult,
  NotifyUnreadResult,
} from '../../dto/notify.dto.js';

@CrudController({
  prefix: 'notify/message',
  label: '我的消息',
  entity: NotifyMessage,
  service: NotifyMessageService,
  api: ['page', 'info'],
  pageQuery: {
    keyWords: ['title'],
    fieldEq: ['event', 'instanceId', 'readAt'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class NotifyMessageController extends BaseController<NotifyMessage> {
  constructor(private readonly messages: NotifyMessageService) {
    super();
  }
  @Post('read')
  @HttpCode(200)
  @Perms('notify:message:info')
  @ApiOperation({
    operationId: 'notifyMessageRead',
    summary: '将本人消息标为已读',
  })
  @ApiBody({ type: NotifyReadBody })
  @ApiResult(NotifyReadResult)
  read(@Body() body: NotifyReadBody) {
    return this.messages.markRead(body.id);
  }

  @Get('unread')
  @Perms('notify:message:page')
  @ApiOperation({
    operationId: 'notifyMessageUnread',
    summary: '本人未读消息数量',
  })
  @ApiResult(NotifyUnreadResult)
  unread() {
    return this.messages.unread();
  }
}
