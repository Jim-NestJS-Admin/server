import { Column, Entity, Index } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';
import { BaseEntity } from '../../../core/crud/base.entity.js';
import { CrudField } from '../../../core/crud/crud-field.decorator.js';

@Entity('mcp_setting')
@Index('uk_mcp_setting', ['tenantId', 'activeGuard'], { unique: true })
export class McpSetting extends BaseEntity {
  @Column({ type: 'boolean', default: false }) enabled!: boolean;
  @Column({ type: 'json' }) blocked!: string[];
  @Column({ type: 'json' }) confirmPermissions!: string[];
}
@Entity('mcp_pending_operation')
@Index('uk_mcp_request', ['tenantId', 'requestHash', 'activeGuard'], {
  unique: true,
})
export class McpOperation extends BaseEntity {
  @Column({ type: 'char', length: 64 }) requestHash!: string;
  @Column({ type: 'char', length: 64 }) digest!: string;
  @CrudField({ label: '发起人', edit: 'none', display: 'users' })
  @Column({ type: 'bigint', unsigned: true })
  ownerId!: string;
  @CrudField({
    label: '确认人',
    edit: 'none',
    nullable: true,
    display: 'users',
  })
  @ApiProperty({ type: String, nullable: true })
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  approverId!: string | null;
  @CrudField({ label: '应用ID', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 200 })
  clientId!: string;
  @Column({ type: 'varchar', length: 100 }) grantId!: string;
  @CrudField({ label: '资源', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 100 })
  resource!: string;
  @CrudField({ label: '动作', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 100 })
  action!: string;
  @Column({ type: 'varchar', length: 150 }) permission!: string;
  @CrudField({
    label: '状态',
    edit: 'none',
    dict: [
      { value: 'pending', label: '待确认', tagType: 'warning' },
      { value: 'succeeded', label: '已执行', tagType: 'success' },
      { value: 'rejected', label: '已拒绝', tagType: 'info' },
      { value: 'expired', label: '已过期', tagType: 'info' },
      { value: 'invalid', label: '已失效', tagType: 'danger' },
    ],
  })
  @IsIn(['pending', 'succeeded', 'rejected', 'expired', 'invalid'])
  @Column({ type: 'varchar', length: 20 })
  status!: 'pending' | 'succeeded' | 'rejected' | 'expired' | 'invalid';
  @Column({ type: 'mediumtext', select: false }) payloadCipher!: string;
  @Column({ type: 'json', nullable: true }) receipt!: Record<
    string,
    unknown
  > | null;
  @CrudField({ label: '确认截止时间', edit: 'none', list: { sortable: true } })
  @Column({ type: 'datetime', precision: 3 })
  expiresAt!: Date;
  @Column({ type: 'bigint', unsigned: true, nullable: true }) confirmedBy!:
    string | null;
  @Column({ type: 'datetime', precision: 3, nullable: true })
  confirmedAt!: Date | null;
}
@Entity('mcp_usage')
@Index('uk_mcp_usage', ['tenantId', 'month', 'activeGuard'], { unique: true })
export class McpUsage extends BaseEntity {
  @Column({ type: 'char', length: 7 }) month!: string;
  @Column({ type: 'int', unsigned: true, default: 0 }) calls!: number;
}
@Entity('mcp_event')
export class McpEvent extends BaseEntity {
  @CrudField({ label: '事件', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 40 })
  event!: string;
  @CrudField({ label: '应用ID', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 200 })
  clientId!: string;
  @CrudField({ label: '资源', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 100 })
  resource!: string;
  @CrudField({ label: '动作', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 100 })
  action!: string;
  @CrudField({ label: '操作编号', edit: 'none', nullable: true })
  @ApiProperty({ type: String, nullable: true })
  @Matches(/^[1-9]\d{0,19}$/)
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  operationId!: string | null;
}
@Entity('oauth_confirm_exempt')
@Index(
  'uk_oauth_exempt',
  ['tenantId', 'clientId', 'orgId', 'permission', 'activeGuard'],
  { unique: true },
)
export class McpExempt extends BaseEntity {
  @Column({ type: 'varchar', length: 200 }) clientId!: string;
  @Column({ type: 'bigint', unsigned: true }) serviceUserId!: string;
  @Column({ type: 'varchar', length: 150 }) permission!: string;
  @Column({ type: 'boolean', default: false }) enabled!: boolean;
}
@Entity('mcp_service_approver')
@Index('uk_mcp_approver', ['tenantId', 'clientId', 'activeGuard'], {
  unique: true,
})
export class McpApprover extends BaseEntity {
  @Column({ type: 'varchar', length: 200 }) clientId!: string;
  @Column({ type: 'bigint', unsigned: true }) approverId!: string;
}
