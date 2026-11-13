import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  IsArray,
  ValidateNested,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { Segment } from '../service/rule-config.js';
export class CodeRuleValidateInput {
  @ApiProperty() @IsString() timezone!: string;
  @ApiProperty() @IsIn(['never', 'year', 'month', 'day']) resetPeriod!: string;
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  @IsArray()
  segments!: Segment[];
  @ApiProperty() @Matches(/^[1-9]\d{0,11}$/) start!: string;
}
export class CodeRuleValidateBody {
  @ApiProperty({ type: CodeRuleValidateInput })
  @Type(() => CodeRuleValidateInput)
  @ValidateNested()
  @IsObject()
  data!: CodeRuleValidateInput;
  @ApiPropertyOptional() @IsOptional() @IsString() usageKey?: string;
}
export class CodeBindingBody {
  @ApiProperty() @Matches(/^[a-z][a-z0-9_]{1,63}$/) usageKey!: string;
  @ApiProperty() @Matches(/^[1-9]\d{0,19}$/) ruleId!: string;
}
export class CodePreviewBody {
  @ApiProperty() @Matches(/^[1-9]\d{0,19}$/) ruleId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() usageKey?: string;
}
export class CodePreviewResult {
  @ApiProperty({ type: [String] }) codes!: string[];
  @ApiProperty() periodKey!: string;
  @ApiProperty() consumes!: boolean;
}
export class CodeUsageItem {
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty() resource!: string;
  @ApiProperty() field!: string;
  @ApiProperty() maxLength!: number;
  @ApiPropertyOptional() minLength?: number;
  @ApiProperty({ enum: ['upper_alnum', 'lower_slug', 'digits'] })
  @IsIn(['upper_alnum', 'lower_slug', 'digits'])
  charset!: string;
  @ApiProperty() uniqueScope!: string;
  @ApiProperty() allowRuleSwitch!: boolean;
  @ApiProperty({ nullable: true, type: String }) ruleId!: string | null;
  @ApiProperty({ nullable: true, type: String }) ruleName!: string | null;
  @ApiProperty() issue!: string;
}
export class CodeUsageResult {
  @ApiProperty({ type: [CodeUsageItem] }) list!: CodeUsageItem[];
}
export class CodeHistoryItem {
  @ApiProperty() revision!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: 'object', additionalProperties: true })
  snapshot!: object;
}
export class CodeHistoryResult {
  @ApiProperty({ type: [CodeHistoryItem] }) list!: CodeHistoryItem[];
}
