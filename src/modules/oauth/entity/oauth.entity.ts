import { Column, Entity, Index } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsString, Matches } from 'class-validator';
import { BaseEntity } from '../../../core/crud/base.entity.js';
import { CrudField } from '../../../core/crud/crud-field.decorator.js';
@Entity('oauth_client')
@Index('uk_oauth_client_id', ['tenantId', 'clientId', 'activeGuard'], {
  unique: true,
})
export class OAuthClient extends BaseEntity {
  @CrudField({ label: '应用ID', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 200 })
  clientId!: string;
  @CrudField({ label: '应用名称', edit: 'none' })
  @Column({ type: 'varchar', length: 100 })
  name!: string;
  @CrudField({ label: '启用', edit: 'none' })
  @IsBoolean()
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;
  @CrudField({ label: '认证方式', edit: 'none' })
  @IsIn(['none', 'client_secret_basic', 'private_key_jwt'])
  @Column({ type: 'varchar', length: 32 })
  authMethod!: 'none' | 'client_secret_basic' | 'private_key_jwt';
  @CrudField({ label: '回调地址', edit: 'none' })
  @Column({ type: 'json' })
  redirectUris!: string[];
  @CrudField({ label: '允许scope', edit: 'none' })
  @Column({ type: 'json' })
  scopes!: string[];
  @Column({ type: 'varchar', length: 100, nullable: true, select: false })
  secretHash!: string | null;
  @CrudField({
    label: '客户端公钥集',
    edit: 'none',
    list: false,
    form: false,
    nullable: true,
  })
  @Column({ type: 'json', nullable: true })
  jwks!: Record<string, unknown> | null;
  @CrudField({ label: '服务账号', edit: 'none', nullable: true })
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  serviceUserId!: string | null;
  @CrudField({ label: '服务组织', edit: 'none', nullable: true })
  @ApiProperty({ type: String, nullable: true })
  @Matches(/^[1-9]\d{0,19}$/)
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  serviceOrgId!: string | null;
  @Column({ type: 'boolean', default: false }) dynamic!: boolean;
}
@Entity('oauth_grant')
@Index('uk_oauth_grant_id', ['tenantId', 'grantId', 'activeGuard'], {
  unique: true,
})
export class OAuthGrant extends BaseEntity {
  @CrudField({ label: '授权ID', edit: 'none' })
  @Column({ type: 'varchar', length: 100 })
  grantId!: string;
  @Column({ type: 'bigint', unsigned: true }) ownerId!: string;
  @CrudField({ label: '应用ID', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 200 })
  clientId!: string;
  @CrudField({ label: '授权scope', edit: 'none' })
  @Column({ type: 'json' })
  scopes!: string[];
  @CrudField({ label: '使用对象', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 500 })
  audience!: string;
  @CrudField({ label: '有效', edit: 'none' })
  @IsBoolean()
  @Column({ type: 'boolean', default: true })
  active!: boolean;
  @Column({ type: 'int', unsigned: true }) clientVersion!: number;
  @Column({ type: 'int', unsigned: true }) userEpoch!: number;
  @Column({ type: 'varchar', length: 16, default: 'human' }) kind!:
    'human' | 'service';
}
@Entity('oauth_event')
export class OAuthEvent extends BaseEntity {
  @CrudField({ label: '事件', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 40 })
  action!: string;
  @CrudField({ label: '应用ID', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 200 })
  clientId!: string;
  @CrudField({ label: '授权ID', edit: 'none', nullable: true })
  @ApiProperty({ type: String, nullable: true })
  @IsString()
  @Column({ type: 'varchar', length: 100, nullable: true })
  grantId!: string | null;
}
@Entity('oauth_scope')
@Index('uk_oauth_scope_code', ['tenantId', 'code', 'activeGuard'], {
  unique: true,
})
export class OAuthScope extends BaseEntity {
  @Column({ type: 'varchar', length: 100 }) code!: string;
  @Column({ type: 'json' }) permissions!: string[];
}
@Entity('oauth_token')
@Index(
  'uk_oauth_token_model',
  ['tenantId', 'model', 'lookupHash', 'activeGuard'],
  { unique: true },
)
export class OAuthToken extends BaseEntity {
  @Column({ type: 'varchar', length: 32 }) model!: string;
  @Column({ type: 'char', length: 64 }) lookupHash!: string;
  @Column({ type: 'varchar', length: 200 }) clientId!: string;
  @Column({ type: 'varchar', length: 100, nullable: true }) grantId!:
    string | null;
  @Column({ type: 'mediumtext', select: false }) valueCipher!: string;
  @Column({ type: 'datetime', precision: 3 }) expiresAt!: Date;
  @Column({ type: 'datetime', precision: 3, nullable: true })
  consumedAt!: Date | null;
}
