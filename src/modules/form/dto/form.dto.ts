import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const FORM_TYPES = [
  'input',
  'inputNumber',
  'switch',
  'select',
  'radio',
  'checkbox',
  'datePicker',
] as const;
export const VALUE_TYPES = [
  'string',
  'number',
  'boolean',
  'array',
  'date',
] as const;
export class FormOptionDto {
  @ApiProperty() label!: string;
  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
  })
  value!: string | number | boolean;
}
export class FormValidationDto {
  @ApiPropertyOptional() precision?: number;
  @ApiPropertyOptional() min?: number;
  @ApiPropertyOptional() max?: number;
  @ApiPropertyOptional({ enum: ['email', 'url'] }) format?: 'email' | 'url';
}
export class FormFieldDto {
  @ApiProperty() field!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: FORM_TYPES }) component!: (typeof FORM_TYPES)[number];
  @ApiProperty({ enum: VALUE_TYPES }) type!: (typeof VALUE_TYPES)[number];
  @ApiProperty() required!: boolean;
  @ApiProperty() visible!: boolean;
  @ApiProperty() multiple!: boolean;
  @ApiProperty() multilingual!: boolean;
  @ApiProperty() queryable!: boolean;
  @ApiProperty({ type: [FormOptionDto] }) options!: FormOptionDto[];
  @ApiProperty({ type: FormValidationDto }) validation!: FormValidationDto;
}
export class FormLinkageDto {
  @ApiProperty() source!: string;
  @ApiProperty({ enum: ['eq', 'ne', 'in'] }) operator!: 'eq' | 'ne' | 'in';
  @ApiProperty({
    description: '与来源字段比较的标量，in 使用标量数组',
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      {
        type: 'array',
        items: {
          oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
        },
      },
    ],
  })
  value!: unknown;
  @ApiProperty() target!: string;
  @ApiProperty({ enum: ['visible', 'required', 'options'] }) action!:
    'visible' | 'required' | 'options';
  @ApiProperty({
    description: '匹配时应用的布尔值或静态选项数组',
    oneOf: [
      { type: 'boolean' },
      {
        type: 'array',
        items: {
          type: 'object',
          required: ['label', 'value'],
          properties: {
            label: { type: 'string' },
            value: {
              oneOf: [
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
              ],
            },
          },
        },
      },
    ],
  })
  whenTrue!: unknown;
  @ApiProperty({
    description: '不匹配时应用的布尔值或静态选项数组',
    oneOf: [
      { type: 'boolean' },
      {
        type: 'array',
        items: {
          type: 'object',
          required: ['label', 'value'],
          properties: {
            label: { type: 'string' },
            value: {
              oneOf: [
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
              ],
            },
          },
        },
      },
    ],
  })
  whenFalse!: unknown;
}
export class FormDesignerDto {
  @ApiProperty({ enum: [1], description: '安全表单契约版本' })
  schemaVersion!: number;
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'FormCreate 规则安全子集，详见 docs/contracts/form.md',
  })
  rule!: Record<string, unknown>[];
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  option?: Record<string, unknown>;
  @ApiPropertyOptional({ type: [FormLinkageDto] }) linkages?: FormLinkageDto[];
}
export class FormDefinitionInput {
  @ApiProperty({ example: 'leave_request' })
  @Matches(/^[a-z][a-z0-9_]{1,63}$/)
  code!: string;
  @ApiProperty() @IsString() @MaxLength(100) @Matches(/\S/) name!: string;
  @ApiProperty({ type: FormDesignerDto })
  @IsObject()
  designer!: FormDesignerDto;
}
export class CreateFormBody {
  @ApiProperty({ type: FormDefinitionInput })
  @Type(() => FormDefinitionInput)
  @ValidateNested()
  @IsObject()
  data!: FormDefinitionInput;
}
export class ReviseFormBody extends CreateFormBody {
  @ApiProperty({ description: '当前最新业务修订号，修订后加1' })
  @IsInt()
  @Min(1)
  @Max(1000000)
  baseRevision!: number;
}
export class ValidateFormBody {
  @ApiProperty({ description: '固定表单版本记录编号' })
  @Matches(/^[1-9]\d{0,19}$/)
  definitionId!: string;
  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  data!: Record<string, unknown>;
}
export class FormValidationResult {
  @ApiProperty() definitionId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: [true] }) valid!: boolean;
}
