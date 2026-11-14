import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { FormDefinition } from '../../form/entity/form-definition.entity.js';
export class WorkflowAvailableBody {
  @ApiPropertyOptional() @IsOptional() @Matches(/^[1-9]\d{0,19}$/) id?: string;
  @ApiPropertyOptional({ default: '' })
  @IsString()
  @MaxLength(100)
  keyword: string = '';
  @ApiPropertyOptional({ default: 1 })
  @IsInt()
  @Min(1)
  @Max(10000)
  page: number = 1;
  @ApiPropertyOptional({ default: 20 }) @IsInt() @Min(1) @Max(50) size: number =
    20;
}
export class WorkflowSelection {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}
export class WorkflowAvailableRow {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() name?: string;
  @ApiPropertyOptional() code?: string;
  @ApiPropertyOptional() revision?: number;
  @ApiProperty() formDefinitionId!: string;
  @ApiProperty({ type: [WorkflowSelection] }) selections!: WorkflowSelection[];
  @ApiPropertyOptional({ type: FormDefinition }) form?: FormDefinition;
}
export class WorkflowAvailableResult {
  @ApiProperty({ type: [WorkflowAvailableRow] }) list!: WorkflowAvailableRow[];
  @ApiProperty() total!: number;
}
