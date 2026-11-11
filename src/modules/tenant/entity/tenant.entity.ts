import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDate,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  NotEquals,
  ValidateNested,
  registerDecorator,
} from 'class-validator';
import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, CrudField } from '../../../core/crud/index.js';
import { FieldPerm } from '../../../core/field-perm/field-perm.decorator.js';

export const TENANT_CODE = /^[a-z][a-z0-9-]{1,31}$/;
export const QUOTA_FIELDS = [
  'maxUsers',
  'storageMb',
  'maxSites',
  'aiTokensMonthly',
  'mcpCallsMonthly',
] as const;
export class TenantQuotas {
  @ApiProperty({ type: Number, nullable: true, default: null })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxUsers: number | null = null;
  @ApiProperty({ type: Number, nullable: true, default: null })
  @IsOptional()
  @IsInt()
  @Min(0)
  storageMb: number | null = null;
  @ApiProperty({ type: Number, nullable: true, default: null })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxSites: number | null = null;
  @ApiProperty({ type: Number, nullable: true, default: null })
  @IsOptional()
  @IsInt()
  @Min(0)
  aiTokensMonthly: number | null = null;
  @ApiProperty({ type: Number, nullable: true, default: null })
  @IsOptional()
  @IsInt()
  @Min(0)
  mcpCallsMonthly: number | null = null;
}

/** 域名只接受主机名和端口；按URL标准统一大小写、默认端口，拒绝本机登录入口绑定。 */
export function normalizeTenantDomain(input: unknown): string | null {
  if (
    typeof input !== 'string' ||
    input.length > 253 ||
    /[\s/@?#\\]/.test(input)
  )
    return null;
  try {
    const url = new URL('http://' + input.toLowerCase());
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        url.hostname,
      ) ||
      url.hostname === 'localhost' ||
      url.hostname.startsWith('127.') ||
      url.hostname === '0.0.0.0'
    )
      return null;
    return url.host;
  } catch {
    return null;
  }
}
function TenantDomains(): PropertyDecorator {
  return (target, property) =>
    registerDecorator({
      name: 'tenantDomains',
      target: target.constructor,
      propertyName: String(property),
      validator: {
        validate: (value: unknown) =>
          Array.isArray(value) &&
          value.every((domain) => normalizeTenantDomain(domain) === domain),
        defaultMessage: () =>
          '域名必须是有效主机名（可带端口），不能绑定localhost或本机回环地址',
      },
    });
}

@Entity('sys_package')
@Index('uk_sys_package_code', ['tenantId', 'code', 'activeGuard'], {
  unique: true,
})
export class TenantPackage extends BaseEntity {
  @CrudField({ label: '套餐编码', edit: 'add', form: { required: true } })
  @Matches(TENANT_CODE, {
    message: '套餐编码为2至32位小写字母、数字或短横线，以字母开头',
  })
  @Column({ type: 'varchar', length: 32 })
  code!: string;
  @CrudField({ label: '套餐名称', form: { required: true } })
  @IsString()
  @MaxLength(100)
  @Matches(/\S/, { message: '套餐名称不能为空' })
  @Column({ type: 'varchar', length: 100 })
  name!: string;
  @CrudField({ label: '启用', form: { component: 'switch' } })
  @IsBoolean()
  @Column({ type: 'boolean', default: true })
  enabled = true;
  @ApiProperty({ type: [String] })
  @CrudField({ label: '可用菜单', list: false })
  @IsArray()
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @Matches(/^[1-9]\d{0,19}$/, { each: true, message: '菜单编号格式不正确' })
  @Column({ type: 'json' })
  menuIds: string[] = [];
  @ApiProperty({ type: TenantQuotas })
  @CrudField({ label: '配额', list: false })
  @IsObject()
  @ValidateNested()
  @Type(() => TenantQuotas)
  @Column({ type: 'json' })
  quotas: TenantQuotas = new TenantQuotas();
  @CrudField({ label: '备注', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Column({ type: 'varchar', length: 500, nullable: true })
  remark!: string | null;
}

@Entity('sys_tenant')
@Index('uk_sys_tenant_code', ['tenantId', 'code', 'activeGuard'], {
  unique: true,
})
export class SystemTenant extends BaseEntity {
  @CrudField({ label: '租户编码', edit: 'add', form: { required: true } })
  @Matches(TENANT_CODE, {
    message: '租户编码为2至32位小写字母、数字或短横线，以字母开头',
  })
  @NotEquals('platform', { message: 'platform是平台保留编码' })
  @Column({ type: 'varchar', length: 32 })
  code!: string;
  @CrudField({ label: '租户名称', form: { required: true } })
  @IsString()
  @MaxLength(100)
  @Matches(/\S/, { message: '租户名称不能为空' })
  @Column({ type: 'varchar', length: 100 })
  name!: string;
  @CrudField({ label: '套餐', form: { required: true } })
  @Matches(/^[1-9]\d{0,19}$/, { message: '套餐编号格式不正确' })
  @Column({ type: 'bigint', unsigned: true })
  packageId!: string;
  @ApiProperty({ type: [String] })
  @CrudField({ label: '绑定域名', list: false })
  @Transform(
    ({ value }: { value: unknown }) =>
      Array.isArray(value)
        ? value.map(
            (domain: unknown) => normalizeTenantDomain(domain) ?? domain,
          )
        : value,
    { toClassOnly: true },
  )
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @TenantDomains()
  @Column({ type: 'json' })
  domains: string[] = [];
  @CrudField({ label: '启用', form: { component: 'switch' } })
  @IsBoolean()
  @Column({ type: 'boolean', default: true })
  enabled = true;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  @CrudField({
    label: '到期时间',
    nullable: true,
    form: { component: 'datetime' },
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: '到期时间格式不正确' })
  @Column({ type: 'datetime', precision: 3, nullable: true })
  expiresAt!: Date | null;
  @CrudField({ label: '联系人', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Column({ type: 'varchar', length: 50, nullable: true })
  contactName!: string | null;
  @CrudField({ label: '联系电话', nullable: true })
  @FieldPerm({ label: '联系电话', default: 'masked', mask: 'phone' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  @Column({ type: 'varchar', length: 30, nullable: true })
  contactPhone!: string | null;
  @CrudField({ label: '备注', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Column({ type: 'varchar', length: 500, nullable: true })
  remark!: string | null;
}
