import { Column, Entity, Index } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { IsDate, IsString, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { BaseEntity } from '../../../core/crud/base.entity.js';
import { CrudField } from '../../../core/crud/crud-field.decorator.js';

/** 只保存事件引用，避免权限变化后旧消息中残留表单值。 */
@Entity('notify_message')
@Index('uk_notify_message_event', ['tenantId', 'eventKey', 'activeGuard'], {
  unique: true,
})
@Index('idx_notify_message_recipient', ['tenantId', 'recipientId', 'readAt'])
export class NotifyMessage extends BaseEntity {
  @Column({ type: 'varchar', length: 120 }) eventKey!: string;
  @Column({ type: 'bigint', unsigned: true }) recipientId!: string;
  @CrudField({ label: '通知类型', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 32 })
  event!: string;
  @CrudField({ label: '消息', edit: 'none' })
  @Column({ type: 'varchar', length: 100 })
  title!: string;
  /** 审批事件引用审批实例；mcp.exempt引用已执行操作，无外键或业务内容。 */
  @CrudField({ label: '业务编号', edit: 'none' })
  @Matches(/^[1-9]\d{0,19}$/)
  @Column({ type: 'bigint', unsigned: true })
  instanceId!: string;
  @ApiProperty({ type: String, nullable: true })
  @CrudField({ label: '关联待办', edit: 'none', list: false, nullable: true })
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  taskId!: string | null;
  @CrudField({ label: '阅读时间', edit: 'none', nullable: true })
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  @Type(() => Date)
  @IsDate()
  @Column({ type: 'datetime', precision: 3, nullable: true })
  readAt!: Date | null;
}

@Entity('notify_delivery')
@Index(
  'uk_notify_delivery_channel',
  ['tenantId', 'messageId', 'channel', 'activeGuard'],
  { unique: true },
)
@Index('idx_notify_delivery_due', ['tenantId', 'status', 'nextAttemptAt'])
export class NotifyDelivery extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true }) messageId!: string;
  @Column({ type: 'varchar', length: 16 }) channel!: string;
  @Column({ type: 'varchar', length: 16, default: 'pending' }) status!:
    'pending' | 'claimed' | 'sent' | 'cancelled';
  @Column({ type: 'int', unsigned: true, default: 0 }) attempts!: number;
  @Column({ type: 'datetime', precision: 3 }) nextAttemptAt!: Date;
  @Column({ type: 'char', length: 36, nullable: true }) claimToken!:
    string | null;
  @Column({ type: 'datetime', precision: 3, nullable: true })
  claimedUntil!: Date | null;
  @Column({ type: 'varchar', length: 200, default: '' }) lastError!: string;
  @Column({ type: 'varchar', length: 200, nullable: true }) externalId!:
    string | null;
}

@Entity('notify_receipt')
@Index('uk_notify_receipt_event', ['tenantId', 'eventKey', 'activeGuard'], {
  unique: true,
})
export class NotifyReceipt extends BaseEntity {
  @Column({ type: 'varchar', length: 120 }) eventKey!: string;
  @Column({ type: 'varchar', length: 64 }) businessType!: string;
  @Column({ type: 'varchar', length: 64 }) businessId!: string;
}
