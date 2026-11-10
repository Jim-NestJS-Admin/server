import { applyDecorators, type Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  Matches,
  Min,
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
} from 'class-validator';
import { ModuleSpec, SpecError } from './module-spec.js';

export class SpecBody {
  // 规格的深层校验由 validateSpec 完成，以保留未知字段并返回准确路径。
  @ApiProperty({ type: ModuleSpec }) @IsObject() spec!: ModuleSpec;
}
export class SaveSpecBody extends SpecBody {
  @ApiPropertyOptional() @IsOptional() @Matches(/^[1-9]\d{0,19}$/) id?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) version?: number;
}
export class WriteSpecBody extends SpecBody {
  @ApiProperty({ description: 'preview-spec 返回的 fingerprint' })
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  fingerprint!: string;
}
export class ImportSpecBody {
  @ApiProperty({ type: [String], minItems: 1, maxItems: 6 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @ArrayUnique()
  @Matches(/^[a-z][a-z0-9_]{0,47}$/, { each: true })
  tables!: string[];
}
export class SpecValidationResult {
  @ApiProperty() valid!: boolean;
  @ApiProperty({ type: [SpecError] }) errors!: SpecError[];
}
export class SpecImportResult {
  @ApiProperty({ type: ModuleSpec }) spec!: ModuleSpec;
  @ApiProperty({ type: [SpecError] }) errors!: SpecError[];
}
export class SpecFile {
  @ApiProperty({ enum: ['server', 'admin'] }) project!: string;
  @ApiProperty() path!: string;
  @ApiProperty({ enum: ['create', 'overwrite', 'unchanged', 'skip-modified'] })
  action!: string;
  @ApiProperty() content!: string;
  @ApiProperty() previous!: string;
  @ApiProperty() diff!: string;
}
export class SpecPreviewResult {
  @ApiProperty() token!: string;
  @ApiProperty() fingerprint!: string;
  @ApiProperty({ type: ModuleSpec }) spec!: ModuleSpec;
  @ApiProperty({ type: [String] }) sql!: string[];
  @ApiProperty({ type: [SpecFile] }) files!: SpecFile[];
  @ApiProperty() note!: string;
  @ApiProperty({ type: [String] }) manualSteps!: string[];
}
export class SpecWriteFailure {
  @ApiProperty() path!: string;
  @ApiProperty() message!: string;
}
export class SpecWriteResult {
  @ApiProperty({ type: [String] }) written!: string[];
  @ApiProperty({ type: [String] }) skipped!: string[];
  @ApiProperty({ type: [SpecWriteFailure] }) failed!: SpecWriteFailure[];
  @ApiProperty({ type: [String] }) manualSteps!: string[];
  @ApiProperty() recovery!: string;
}
export class SpecSaveResult {
  @ApiProperty() id!: string;
}
export class SpecRecord {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() label!: string;
  @ApiProperty() version!: number;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({ type: ModuleSpec }) spec!: ModuleSpec;
  @ApiProperty({ enum: ['notGenerated', 'generated', 'modified'] })
  status!: string;
}
export class SpecTable {
  @ApiProperty() table!: string;
  @ApiProperty() comment!: string;
  @ApiProperty() fieldCount!: number;
}
export class SpecFieldType {
  @ApiProperty() type!: string;
  @ApiProperty() label!: string;
  @ApiProperty() databaseType!: string;
  @ApiPropertyOptional() defaultLength?: number;
  @ApiPropertyOptional() precision?: number;
  @ApiPropertyOptional() scale?: number;
  @ApiProperty() component!: string;
  @ApiProperty({ type: [String] }) options!: string[];
}
export function ApiCodegenArray(model: Type) {
  return applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      schema: {
        type: 'object',
        required: ['code', 'data', 'message'],
        properties: {
          code: { type: 'integer', enum: [1000] },
          data: { type: 'array', items: { $ref: getSchemaPath(model) } },
          message: { type: 'string' },
        },
      },
    }),
  );
}
