import { Injectable } from '@nestjs/common';
import { TenantRepositoryFactory } from '../../../core/tenant/tenant-repository.js';
import {
  NotificationChannel,
  type NotificationReference,
} from '../../notify/service/notify-ports.js';
import { UserSocial, IntegrationCard } from '../entity/integration.entity.js';
import { WorkflowOutboxService } from '../../workflow/service/workflow-outbox.service.js';
import { IntegrationCrypto } from './integration-crypto.js';
import { IntegrationAppService } from './integration-app.service.js';
import { WecomAdapter } from './wecom-adapter.js';

@Injectable()
export class IntegrationNotificationChannel extends NotificationChannel {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly apps: IntegrationAppService,
    private readonly adapter: WecomAdapter,
    private readonly workflow: WorkflowOutboxService,
    private readonly crypto: IntegrationCrypto,
  ) {
    super();
  }
  async channels(recipientId: string) {
    const app = await this.apps.configured();
    if (!app) return [];
    return (await this.binding(recipientId, app.corpId)) ? ['wecom'] : [];
  }
  private binding(userId: string, corpId: string) {
    return this.repos
      .for(UserSocial)
      .query('s')
      .andWhere(
        's.userId = :userId AND s.corpId = :corpId AND s.platform = :platform',
        { userId, corpId, platform: 'wecom' },
      )
      .getOne();
  }
  async send(channel: string, message: NotificationReference) {
    if (channel !== 'wecom') throw new Error('未知通知渠道');
    const app = await this.apps.configured();
    if (!app) throw new Error('企业微信配置已停用');
    const social = await this.binding(message.recipientId, app.corpId);
    if (!social) throw new Error('成员绑定已失效');
    const url = `${app.adminUrl}#/workflow/workbench?instanceId=${encodeURIComponent(message.instanceId)}${message.taskId ? '&taskId=' + encodeURIComponent(message.taskId) : ''}`;
    if (message.taskId && message.event === 'task.created') {
      const task = await this.workflow.taskReference(message.taskId);
      if (
        !task ||
        task.status !== 'pending' ||
        task.assigneeId !== message.recipientId
      )
        throw new Error('待办已失效');
      let card = await this.repos
        .for(IntegrationCard)
        .query('c')
        .andWhere('c.eventKey = :key', { key: message.eventKey })
        .getOne();
      if (!card) {
        const id = await this.repos.for(IntegrationCard).insert({
          eventKey: message.eventKey,
          appId: app.id,
          taskId: task.id,
          taskVersion: task.version,
          recipientId: message.recipientId,
          externalId: social.externalId,
          responseCipher: null,
          updated: false,
        });
        card = Object.assign(new IntegrationCard(), { id });
      }
      const result = await this.adapter.api(
        app,
        this.apps.credentials(app).secret,
        'message/send',
        {},
        {
          touser: social.externalId,
          agentid: Number(app.agentId),
          msgtype: 'template_card',
          template_card: {
            card_type: 'button_interaction',
            task_id: card.id,
            main_title: { title: message.title },
            card_action: { type: 1, url },
            button_list: [
              { text: '同意', style: 1, key: 'approve' },
              { text: '查看详情', type: 1, url },
            ],
          },
          enable_duplicate_check: 1,
          duplicate_check_interval: 14400,
        },
      );
      if (
        result.invaliduser ||
        result.unlicenseduser ||
        typeof result.response_code !== 'string'
      )
        throw new Error('审批卡片投递失败');
      await this.repos.for(IntegrationCard).update([card.id], {
        responseCipher: this.crypto.encrypt(
          result.response_code,
          this.apps.aad('card:' + card.id),
        ),
      });
      return typeof result.msgid === 'string' ? result.msgid : null;
    }
    const result = await this.adapter.api(
      app,
      this.apps.credentials(app).secret,
      'message/send',
      {},
      {
        touser: social.externalId,
        agentid: Number(app.agentId),
        msgtype: 'textcard',
        textcard: {
          title: message.title,
          description: '请打开审批工作台查看并办理。',
          url,
          btntxt: '查看详情',
        },
        enable_duplicate_check: 1,
        duplicate_check_interval: 14400,
      },
    );
    if (result.invaliduser || result.unlicenseduser)
      throw new Error('企业微信成员不可接收消息');
    return typeof result.msgid === 'string' ? result.msgid : null;
  }
}
