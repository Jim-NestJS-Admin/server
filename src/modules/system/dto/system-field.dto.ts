import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { FIELD_MASKS, FIELD_STATES } from '../entity/system-field.entity.js';
import { ID_PATTERN } from '../../../core/crud/crud.dto.js';
import type {
  FieldState,
  MaskRule,
} from '../../../core/field-perm/field-perm.decorator.js';

export class FieldConfigurationChange {
  @ApiProperty()
  @Matches(/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/)
  resource: string;
  @ApiProperty() @Matches(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/) field: string;
  @ApiProperty({
    enum: FIELD_STATES,
    nullable: true,
    description: 'null表示跟随默认；新增配置version传0',
  })
  @IsOptional()
  @IsIn(FIELD_STATES)
  state: FieldState | null;
  @ApiPropertyOptional({ enum: FIELD_MASKS, nullable: true })
  @IsOptional()
  @IsIn(FIELD_MASKS)
  mask?: MaskRule | null;
  @ApiPropertyOptional({ enum: FIELD_STATES, nullable: true })
  @IsOptional()
  @IsIn(FIELD_STATES)
  delegable?: FieldState | null;
  @ApiProperty() @IsInt() @Min(0) version: number;
}
export class SaveFieldConfigurations {
  @ApiProperty({ type: [FieldConfigurationChange], maxItems: 500 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => FieldConfigurationChange)
  changes: FieldConfigurationChange[];
}
export class SaveRoleFieldConfigurations extends SaveFieldConfigurations {
  @ApiProperty({ type: String }) @Matches(ID_PATTERN) roleId: string;
}
export class FieldConfigurationResult {
  @ApiProperty() count: number;
}

export class RoleFieldOverviewQuery {
  @ApiProperty({ type: String }) @Matches(ID_PATTERN) roleId: string;
}
export class FieldConfigurationEntry {
  @ApiProperty() resource: string;
  @ApiProperty() resourceLabel: string;
  @ApiProperty() field: string;
  @ApiProperty() label: string;
  @ApiProperty({ enum: FIELD_STATES }) codeDefault: FieldState;
  @ApiProperty({ enum: FIELD_MASKS, nullable: true }) codeMask: MaskRule | null;
  @ApiProperty({ enum: FIELD_STATES, nullable: true })
  codeDelegable: FieldState | null;
  @ApiProperty({ enum: FIELD_STATES }) defaultState: FieldState;
  @ApiProperty({ enum: FIELD_MASKS, nullable: true })
  defaultMask: MaskRule | null;
  @ApiProperty({ enum: FIELD_STATES, nullable: true })
  defaultDelegable: FieldState | null;
  @ApiProperty({
    description: 'null表示跟随默认',
    enum: FIELD_STATES,
    nullable: true,
  })
  state: FieldState | null;
  @ApiProperty({ enum: FIELD_MASKS, nullable: true }) mask: MaskRule | null;
  @ApiProperty({ enum: FIELD_STATES, nullable: true })
  delegable: FieldState | null;
  @ApiProperty({ description: '当前目标覆盖版本；没有覆盖为0' })
  version: number;
}
export class FieldConfigurationOverview {
  @ApiProperty({ type: [FieldConfigurationEntry] })
  fields: FieldConfigurationEntry[];
}
