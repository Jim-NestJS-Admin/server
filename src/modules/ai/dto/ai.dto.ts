import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  ValidateNested,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
export class AiConfigSaveBody {
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty() @Matches(/^[a-zA-Z0-9._:-]{1,150}$/) model!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(8192) maxOutputTokens!: number;
  @ApiPropertyOptional({ writeOnly: true })
  @IsOptional()
  @IsString()
  @Length(10, 512)
  apiKey?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() usePlatformKey?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) version?: number;
}
export class AiConfigResult {
  @ApiProperty() enabled!: boolean;
  @ApiProperty() model!: string;
  @ApiProperty() maxOutputTokens!: number;
  @ApiProperty() version!: number;
  @ApiProperty() hasTenantKey!: boolean;
  @ApiProperty() hasPlatformKey!: boolean;
  @ApiProperty() encryptionReady!: boolean;
}
export class AiTemplateSaveBody {
  @ApiProperty({ enum: ['generate', 'rewrite', 'translate'] })
  @IsIn(['generate', 'rewrite', 'translate'])
  code!: string;
  @ApiProperty() @IsString() @Length(1, 12000) content!: string;
  @ApiProperty({ description: '本租户最新修订号；无覆盖时为0' })
  @IsInt()
  @Min(0)
  revision!: number;
}
export class AiSubmitBody {
  @ApiProperty({ enum: ['generate', 'rewrite', 'translate'] })
  @IsIn(['generate', 'rewrite', 'translate'])
  feature!: string;
  @ApiProperty() @IsString() @Length(1, 16000) text!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  instruction?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 100)
  language?: string;
}
export class AiTaskIdBody {
  @ApiProperty() @Matches(/^[1-9]\d{0,19}$/) id!: string;
}
export class AiReceipt {
  @ApiProperty() id!: string;
}
export class AiTaskResult {
  @ApiProperty() id!: string;
  @ApiProperty({
    enum: ['queued', 'running', 'succeeded', 'failed', 'uncertain'],
  })
  status!: string;
  @ApiProperty() text!: string;
  @ApiProperty() error!: string;
}
export class AiUsageResult {
  @ApiProperty() month!: string;
  @ApiProperty() usedTokens!: string;
  @ApiProperty() reservedTokens!: string;
  @ApiProperty({ type: Number, nullable: true }) limit!: number | null;
}
export class AiTemplateChoice {
  @ApiProperty() code!: string;
  @ApiProperty() content!: string;
  @ApiProperty() revision!: number;
  @ApiProperty() tenantRevision!: number;
}
export class AiTemplatesResult {
  @ApiProperty({ type: [AiTemplateChoice] }) list!: AiTemplateChoice[];
}
export class AiBatchBody {
  @ApiProperty({ type: [AiSubmitBody] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AiSubmitBody)
  items!: AiSubmitBody[];
}
export class AiBatchResult {
  @ApiProperty({ type: [String] }) ids!: string[];
}
export class AiReconcileBody {
  @ApiProperty() @Matches(/^[1-9]\d{0,19}$/) id!: string;
  @ApiProperty() @IsInt() @Min(1) version!: number;
  @ApiProperty() @IsBoolean() charged!: boolean;
  @ApiProperty() @IsInt() @Min(0) @Max(10000000) inputTokens!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(10000000) outputTokens!: number;
  @ApiProperty({ description: '提供方账单或请求核对依据，不填写密钥/正文' })
  @IsString()
  @Length(5, 200)
  evidence!: string;
}
export class AiUncertainItem {
  @ApiProperty() id!: string;
  @ApiProperty() version!: number;
  @ApiProperty() model!: string;
  @ApiProperty() reservedTokens!: string;
  @ApiProperty() createdAt!: string;
}
export class AiUncertainResult {
  @ApiProperty({ type: [AiUncertainItem] }) list!: AiUncertainItem[];
}
