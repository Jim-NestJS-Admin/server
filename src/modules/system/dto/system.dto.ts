import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';
import { ID_PATTERN } from '../../../core/crud/crud.dto.js';

export class CreateSystemUser {
  @ApiProperty() @Matches(/^[a-z][a-z0-9_.-]{2,63}$/) username: string;
  @ApiProperty({
    writeOnly: true,
    description: '初始密码，按普通用户密码规则检查',
  })
  @IsString()
  password: string;
  @ApiProperty() @IsString() @Length(1, 100) nickname: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Matches(ID_PATTERN)
  defaultOrgId?: string | null;
}
export class ResetSystemPassword {
  @ApiProperty({ type: String }) @Matches(ID_PATTERN) id: string;
  @ApiProperty() @IsInt() @Min(1) version: number;
  @ApiProperty({ writeOnly: true }) @IsString() password: string;
}
export class ChangeSystemPassword {
  @ApiProperty() @IsInt() @Min(1) version: number;
  @ApiProperty({ writeOnly: true }) @IsString() oldPassword: string;
  @ApiProperty({ writeOnly: true }) @IsString() password: string;
}
export class SystemMutationResult {
  @ApiProperty({ type: String }) id: string;
}
