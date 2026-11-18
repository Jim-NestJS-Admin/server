import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export interface NotificationReference {
  eventKey: string;
  event: string;
  recipientId: string;
  instanceId: string;
  taskId: string | null;
  title: string;
}

/** 渠道只接收已裁剪的固定提示，平台 API 由 integration 实现。 */
export abstract class NotificationChannel {
  abstract channels(recipientId: string): Promise<string[]>;
  abstract send(
    channel: string,
    message: NotificationReference,
  ): Promise<string | null>;
}

export interface WorkflowBusinessConsumer {
  type: string;
  approved(
    input: { eventKey: string; businessId: string },
    manager: EntityManager,
  ): Promise<void>;
}

@Injectable()
export class NotificationBusinessRegistry {
  private readonly consumers = new Map<string, WorkflowBusinessConsumer>();
  register(consumer: WorkflowBusinessConsumer) {
    if (this.consumers.has(consumer.type))
      throw new Error('审批业务回调重复注册');
    this.consumers.set(consumer.type, consumer);
  }
  async approved(
    type: string,
    businessId: string,
    eventKey: string,
    manager: EntityManager,
  ) {
    // 动态表单审批没有额外业务状态；CMS 等模块必须明确注册事务内消费者。
    if (type === 'form/submission') return;
    const consumer = this.consumers.get(type);
    if (!consumer) throw new Error('审批业务回调尚未注册');
    await consumer.approved({ businessId, eventKey }, manager);
  }
}
