import { Column, Entity, Index } from 'typeorm';
import { IsBoolean, IsIn, IsString, Matches } from 'class-validator';
import { BaseEntity } from '../../../core/crud/base.entity.js';
import { CrudField } from '../../../core/crud/crud-field.decorator.js';

@Entity('sys_integration_app')
@Index('uk_integration_app_platform', ['tenantId', 'platform', 'activeGuard'], {
  unique: true,
})
export class IntegrationApp extends BaseEntity {
  @CrudField({ label: '平台', edit: 'none' })
  @IsIn(['wecom'])
  @Column({ type: 'varchar', length: 16 })
  platform!: 'wecom';
  @CrudField({ label: '企业ID', edit: 'none' })
  @Column({ type: 'varchar', length: 100 })
  corpId!: string;
  @CrudField({ label: '应用ID', edit: 'none' })
  @Column({ type: 'varchar', length: 32 })
  agentId!: string;
  @CrudField({ label: '挂载组织', edit: 'none', display: 'orgs' })
  @Matches(/^[1-9]\d{0,19}$/)
  @Column({ type: 'bigint', unsigned: true })
  mountOrgId!: string;
  @CrudField({ label: '默认角色', edit: 'none', nullable: true })
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  defaultRoleId!: string | null;
  @CrudField({ label: '启用', edit: 'none' })
  @IsBoolean()
  @Column({ type: 'boolean', default: false })
  enabled!: boolean;
  @CrudField({ label: '后台地址', edit: 'none' })
  @Column({ type: 'varchar', length: 500 })
  adminUrl!: string;
  @Column({ type: 'text', select: false }) secretCipher!: string;
  @Column({ type: 'text', select: false }) tokenCipher!: string;
  @Column({ type: 'text', select: false }) aesCipher!: string;
}

@Entity('sys_user_social')
@Index(
  'uk_user_social_external',
  ['tenantId', 'corpId', 'externalId', 'activeGuard'],
  { unique: true },
)
export class UserSocial extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true }) userId!: string;
  @Column({ type: 'varchar', length: 16 }) platform!: 'wecom';
  @Column({ type: 'varchar', length: 100 }) corpId!: string;
  @Column({ type: 'varchar', length: 100 }) externalId!: string;
}

@Entity('sys_org_social')
@Index(
  'uk_org_social_external',
  ['tenantId', 'corpId', 'externalId', 'activeGuard'],
  { unique: true },
)
export class OrgSocial extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true }) organizationId!: string;
  @Column({ type: 'varchar', length: 100 }) corpId!: string;
  @Column({ type: 'varchar', length: 32 }) externalId!: string;
}

@Entity('sys_integration_inbox')
@Index('uk_integration_inbox_event', ['tenantId', 'eventKey', 'activeGuard'], {
  unique: true,
})
export class IntegrationInbox extends BaseEntity {
  @Column({ type: 'varchar', length: 64 }) eventKey!: string;
  @Column({ type: 'bigint', unsigned: true }) appId!: string;
  @Column({ type: 'text', select: false }) payloadCipher!: string;
  @Column({ type: 'varchar', length: 16 }) status!: 'pending' | 'done';
  @Column({ type: 'int', unsigned: true, default: 0 }) attempts!: number;
  @Column({ type: 'datetime', precision: 3 }) nextAttemptAt!: Date;
}

@Entity('sys_sync_log')
export class IntegrationSyncLog extends BaseEntity {
  @CrudField({ label: '应用编号', edit: 'none' })
  @Matches(/^[1-9]\d{0,19}$/)
  @Column({ type: 'bigint', unsigned: true })
  appId!: string;
  @CrudField({ label: '状态', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 16 })
  status!: string;
  @CrudField({ label: '处理部门数', edit: 'none' })
  @Column({ type: 'int', unsigned: true })
  organizations!: number;
  @CrudField({ label: '处理成员数', edit: 'none' })
  @Column({ type: 'int', unsigned: true })
  users!: number;
  @CrudField({ label: '说明', edit: 'none' })
  @Column({ type: 'varchar', length: 200 })
  detail!: string;
}

@Entity('sys_integration_card')
@Index('uk_integration_card_event', ['tenantId', 'eventKey', 'activeGuard'], {
  unique: true,
})
export class IntegrationCard extends BaseEntity {
  @Column({ type: 'varchar', length: 120 }) eventKey!: string;
  @Column({ type: 'bigint', unsigned: true }) appId!: string;
  @Column({ type: 'bigint', unsigned: true }) taskId!: string;
  @Column({ type: 'int', unsigned: true }) taskVersion!: number;
  @Column({ type: 'bigint', unsigned: true }) recipientId!: string;
  @Column({ type: 'varchar', length: 100 }) externalId!: string;
  @Column({ type: 'text', select: false, nullable: true }) responseCipher!:
    string | null;
  @Column({ type: 'boolean', default: false }) updated!: boolean;
}
