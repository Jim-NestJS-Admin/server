import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayMaxSize,
  ValidateIf,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  IsArray,
  ValidateNested,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  CODE_START_MESSAGE,
  codeSegmentsReadyForStart,
  type Segment,
} from '../service/rule-config.js';
export class CodeRuleValidateInput {
  @ApiProperty() @IsString() timezone!: string;
  @ApiProperty() @IsIn(['never', 'year', 'month', 'day']) resetPeriod!: string;
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  @IsArray({ message: '请添加编码段' })
  @ArrayMinSize(1, { message: '请至少添加一个编码段，并将流水号放在最后。' })
  @ArrayMaxSize(4, { message: '编码段最多只能配置4段。' })
  segments!: Segment[];
  @ApiProperty()
  @ValidateIf((input: { segments?: unknown }) =>
    codeSegmentsReadyForStart(input.segments),
  )
  @Matches(/^[1-9]\d{0,11}$/, { message: CODE_START_MESSAGE })
  start!: string;
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
  @ApiProperty({
    enum: ['upper_alnum', 'lower_slug', 'digits', 'unrestricted'],
  })
  @IsIn(['upper_alnum', 'lower_slug', 'digits', 'unrestricted'])
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
export class CodeTimeZoneItem {
  @ApiProperty() value!: string;
  @ApiProperty() labelZh!: string;
  @ApiProperty() labelEn!: string;
  @ApiProperty() common!: boolean;
}
export class CodeTimeZoneResult {
  @ApiProperty({ type: [CodeTimeZoneItem] }) list!: CodeTimeZoneItem[];
}
