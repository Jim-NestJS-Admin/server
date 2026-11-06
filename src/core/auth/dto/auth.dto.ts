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

export class ProfileResult {
  @ApiProperty({ type: ProfileUser }) user!: ProfileUser;
  @ApiProperty({ type: OrgOption, nullable: true })
  currentOrg!: OrgOption | null;
  @ApiProperty({ type: [OrgOption], description: '有角色的组织，可以切换' })
  orgs!: OrgOption[];
  @ApiProperty({ example: 'zh-CN' }) locale!: string;
}
