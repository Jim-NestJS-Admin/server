import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  IsInt,
  Min,
} from 'class-validator';
export class IntegrationSaveBody {
  @ApiPropertyOptional() @IsOptional() @Matches(/^[1-9]\d{0,19}$/) id?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) version?: number;
  @ApiProperty() @Matches(/^[a-zA-Z0-9_-]{2,100}$/) corpId!: string;
  @ApiProperty() @Matches(/^[1-9]\d{0,15}$/) agentId!: string;
  @ApiProperty() @Matches(/^[1-9]\d{0,19}$/) mountOrgId!: string;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Matches(/^[1-9]\d{0,19}$/)
  defaultRoleId?: string | null;
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty() @IsString() @Length(1, 500) adminUrl!: string;
  @ApiPropertyOptional({ writeOnly: true })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  secret?: string;
  @ApiPropertyOptional({ writeOnly: true })
  @IsOptional()
  @Matches(/^[a-zA-Z0-9]{3,32}$/)
  callbackToken?: string;
  @ApiPropertyOptional({ writeOnly: true })
  @IsOptional()
  @Matches(/^[a-zA-Z0-9+/]{43}$/)
  encodingAESKey?: string;
}
export class IntegrationIdBody {
  @ApiProperty() @Matches(/^[1-9]\d{0,19}$/) id!: string;
}
export class IntegrationSavedResult {
  @ApiProperty() id!: string;
}
export class IntegrationLoginStartBody {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(
    /^\/workflow\/workbench\?instanceId=[1-9]\d{0,19}(?:&taskId=[1-9]\d{0,19})?$/,
  )
  returnPath?: string;
  @ApiProperty() @IsBoolean() desktop!: boolean;
}
export class IntegrationLoginStartResult {
  @ApiProperty() url!: string;
  @ApiProperty() state!: string;
}
export class IntegrationLoginBody {
  @ApiProperty() @Matches(/^[a-zA-Z0-9_-]{32,128}$/) state!: string;
  @ApiProperty() @IsString() @Length(1, 512) code!: string;
}
