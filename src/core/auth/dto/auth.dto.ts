import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CaptchaQueryDto {
  @ApiProperty({ enum: ['login'], description: '用途，后台只有 login' })
  @IsIn(['login'])
  purpose!: 'login';

  @ApiProperty({ description: '用户输入的账号原文，出题和登录必须传同一个值' })
  @IsString()
  @MaxLength(64)
  account!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'admin', description: '不区分大小写，首尾空格忽略' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  username!: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;

  @ApiPropertyOptional({
    description: '验证码编号（出题接口返回的 captchaId）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  captchaId?: string;

  @ApiPropertyOptional({ description: '用户看图输入的验证码，不区分大小写' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  captchaCode?: string;
}

export class SwitchOrgDto {
  @ApiProperty({ description: '要切换到的组织编号' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  orgId!: string;
}

export class CaptchaResultDto {
  @ApiProperty({ description: '验证码编号，登录时原样带上' })
  captchaId!: string;
  @ApiProperty({
    description:
      '验证码图片（data:image/svg+xml;base64,...），直接放进 img 的 src',
  })
  image!: string;
}

export class TokenResult {
  @ApiProperty({
    description: '访问令牌，只放内存，放在 Authorization: Bearer 头里',
  })
  accessToken!: string;
  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';
  @ApiProperty({ description: '访问令牌多少秒后过期', example: 1800 })
  expiresIn!: number;
}

export class OrgOption {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [String], description: '从根到自己的名称' })
  path!: string[];
}

export class ProfileUser {
  @ApiProperty() id!: string;
  @ApiProperty() username!: string;
  @ApiProperty() nickname!: string;
  @ApiProperty({ type: String, nullable: true }) avatar!: string | null;
}

export class ProfileTenant {
  @ApiProperty({ description: '租户编号（平台为 0）' }) id!: string;
  @ApiProperty({ description: '租户编码，登录时填写' }) code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: '是不是平台（管理所有租户）' })
  platform!: boolean;
}

export class TenantHintTenant {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

export class TenantHintResult {
  @ApiProperty({
    enum: ['domain', 'code'],
    description:
      'domain：域名已绑定租户，登录页不用填租户编码；code：要填租户编码（不填等同默认租户）',
  })
  mode!: 'domain' | 'code';
  @ApiPropertyOptional({ type: TenantHintTenant })
  tenant?: TenantHintTenant;
}

export class ProfileResult {
  @ApiProperty({ type: ProfileTenant }) tenant!: ProfileTenant;
  @ApiProperty({ description: '当前组织下有效的超级管理员身份' })
  superAdmin!: boolean;
  @ApiProperty({ type: ProfileUser }) user!: ProfileUser;
  @ApiProperty({ type: OrgOption, nullable: true })
  currentOrg!: OrgOption | null;
  @ApiProperty({ type: [OrgOption], description: '有角色的组织，可以切换' })
  orgs!: OrgOption[];
  @ApiProperty({ example: 'zh-CN' }) locale!: string;
}
