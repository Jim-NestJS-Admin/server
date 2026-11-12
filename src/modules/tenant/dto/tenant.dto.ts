import { ApiProperty, PickType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsObject,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { SystemTenant, TenantQuotas } from '../entity/tenant.entity.js';
export class CreateTenantData extends PickType(SystemTenant, [
  'code',
  'name',
  'packageId',
  'domains',
  'enabled',
  'expiresAt',
  'contactName',
  'contactPhone',
  'remark',
] as const) {}
export class TenantCreationResult extends PickType(SystemTenant, [
  'id',
  'version',
] as const) {}
export class CreateTenantBody {
  @ApiProperty({ type: CreateTenantData })
  @IsObject()
  @ValidateNested()
  @Type(() => CreateTenantData)
  data!: CreateTenantData;
  @ApiProperty({ description: '初始管理员账号' })
  @IsString()
  @MaxLength(64)
  adminUsername!: string;
  @ApiProperty({
    description: '初始管理员密码，仅用于创建，不返回',
    writeOnly: true,
  })
  @IsString()
  @MaxLength(72)
  adminPassword!: string;
}
export class TenantIdBody {
  @ApiProperty({ type: String }) @Matches(/^[1-9]\d{0,19}$/) id!: string;
}
export class TenantUsageResult {
  @ApiProperty({ type: String }) tenantId!: string;
  @ApiProperty() users!: number;
  @ApiProperty({
    type: String,
    description: '已用字节，十进制字符串，避免大数丢精度',
  })
  storageBytes!: string;
  @ApiProperty({ type: TenantQuotas }) quotas!: TenantQuotas;
}
export class PackageMenuItem {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, nullable: true }) parentId!: string | null;
  @ApiProperty({ enum: ['directory', 'page', 'button'] }) type!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) permission!: string | null;
  @ApiProperty({ type: () => [PackageMenuItem] }) children!: PackageMenuItem[];
}
