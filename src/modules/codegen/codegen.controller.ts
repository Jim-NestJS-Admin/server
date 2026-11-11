import { CrudSchema } from '../../core/crud/crud-schema.js';
import { validateSpec } from './module-spec.js';
import {
  ApiCodegenArray,
  SpecBody,
  SaveSpecBody,
  WriteSpecBody,
  ImportSpecBody,
  SpecValidationResult,
  SpecImportResult,
  SpecPreviewResult,
  SpecWriteResult,
  SpecSaveResult,
  SpecRecord,
  SpecTable,
  SpecFieldType,
} from './codegen.dto.js';
import { Body, HttpCode, Post, StreamableFile } from '@nestjs/common';
import { RawResponse } from '../../core/decorators/raw-response.decorator.js';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import { AdminController } from '../../core/endpoint/endpoint.decorators.js';
import { Perms } from '../../core/permission/perms.decorator.js';
import {
  ApiBinaryResult,
  ApiErrors,
  ApiResult,
} from '../../core/swagger/api-result.js';
import { CodegenService } from './codegen.service.js';

const ID = /^[1-9]\d{0,19}$/;

class IdBody {
  @ApiProperty() @Matches(ID) id!: string;
}
class TableBody {
  @ApiProperty({ example: 'crm_customer' })
  @Matches(/^[a-z][a-z0-9_]{0,62}$/)
  table!: string;
}
class WriteBody extends IdBody {
  @ApiProperty({ description: '预览返回的 token' })
  @Matches(/^[A-Za-z0-9_-]{20,100}$/)
  token!: string;
  @ApiPropertyOptional({
    type: [String],
    description: '手改过但仍要覆盖的文件路径',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  overwrite?: string[];
}

class SaveBody {
  @ApiPropertyOptional({ description: '不带是新建' })
  @IsOptional()
  @Matches(ID)
  id?: string;
  @ApiPropertyOptional({ description: '修改时带读到的版本' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;
  @ApiProperty({
    type: Object,
    description: '生成配置（契约 codegen.md 第 2 节）',
  })
  @IsObject()
  config!: object;
}

/**
 * 代码生成（T21）：只在开发环境且 CODEGEN_ENABLED=true 时注册（AppModule 里按配置装配），生产环境没有这些接口。
 */
@ApiTags('dev 代码生成')
@ApiBearerAuth()
@AdminController('dev/codegen')
export class CodegenController {
  constructor(private readonly codegen: CodegenService) {}

  @Post('field-types')
  @HttpCode(200)
  @Perms('dev:codegen:save')
  @ApiOperation({
    operationId: 'devCodegenFieldTypes',
    summary: '支持的字段类型与默认设置',
  })
  @ApiCodegenArray(SpecFieldType)
  @ApiErrors(401, 403)
  fieldTypes() {
    return this.codegen.fieldTypes();
  }

  @Post('validate-spec')
  @HttpCode(200)
  @Perms('dev:codegen:save')
  @ApiOperation({
    operationId: 'devCodegenValidateSpec',
    summary: '逐字段校验模块规格',
  })
  @ApiResult(SpecValidationResult)
  @ApiErrors(400, 401, 403)
  validateSpec(@Body() b: SpecBody) {
    const errors = validateSpec(b.spec);
    return { valid: !errors.length, errors };
  }

  @Post('import-spec')
  @HttpCode(200)
  @Perms('dev:codegen:save')
  @ApiOperation({
    operationId: 'devCodegenImportSpec',
    summary: '从一张或多张表推断规格草稿',
  })
  @ApiResult(SpecImportResult)
  @ApiErrors(400, 401, 403, 404)
  importSpec(@Body() b: ImportSpecBody) {
    return this.codegen.importSpec(b.tables);
  }

  @Post('save-spec')
  @HttpCode(200)
  @Perms('dev:codegen:save')
  @ApiOperation({ operationId: 'devCodegenSaveSpec', summary: '保存规格草稿' })
  @ApiResult(SpecSaveResult)
  @ApiErrors(400, 401, 403, 404, 409)
  saveSpec(@Body() b: SaveSpecBody) {
    return this.codegen.saveSpec(b.id ?? null, b.version ?? null, b.spec);
  }

  @Post('preview-spec')
  @HttpCode(200)
  @Perms('dev:codegen:save')
  @ApiOperation({
    operationId: 'devCodegenPreviewSpec',
    summary: '预览规格的 SQL、文件、差异和指纹',
  })
  @ApiResult(SpecPreviewResult)
  @ApiErrors(400, 401, 403)
  previewSpec(@Body() b: SpecBody) {
    return this.codegen.previewSpec(b.spec);
  }

  @Post('write-spec')
  @HttpCode(200)
  @Perms('dev:codegen:write', { risk: 'high' })
  @ApiOperation({
    operationId: 'devCodegenWriteSpec',
    summary: '核对预览指纹后写入规格代码',
  })
  @ApiResult(SpecWriteResult)
  @ApiErrors(400, 401, 403, 409)
  writeSpec(@Body() b: WriteSpecBody) {
    return this.codegen.writeSpec(b.spec, b.fingerprint, b.overwrite ?? []);
  }

  @Post('schema-spec')
  @HttpCode(200)
  @Perms('dev:codegen:save')
  @ApiOperation({
    operationId: 'devCodegenSchemaSpec',
    summary: '按规格计算正式 CRUD 页面描述',
  })
  @ApiResult(CrudSchema)
  @ApiErrors(400, 401, 403)
  schemaSpec(@Body() b: SpecBody) {
    return this.codegen.schemaSpec(b.spec);
  }

  @Post('list')
  @HttpCode(200)
  @Perms('dev:codegen:list')
  @ApiOperation({ operationId: 'devCodegenList', summary: '生成配置列表' })
  @ApiCodegenArray(SpecRecord)
  @ApiErrors(401, 403)
  list() {
    return this.codegen.list();
  }

  @Post('info')
  @HttpCode(200)
  @Perms('dev:codegen:list')
  @ApiOperation({ operationId: 'devCodegenInfo', summary: '生成配置详情' })
  @ApiResult()
  @ApiErrors(400, 404)
  info(@Body() b: IdBody) {
    return this.codegen.info(b.id);
  }

  @Post('save')
  @HttpCode(200)
  @Perms('dev:codegen:save')
  @ApiOperation({
    operationId: 'devCodegenSave',
    summary: '保存生成配置（新建或修改）',
  })
  @ApiResult()
  @ApiErrors(400, 404, 409)
  save(@Body() b: SaveBody) {
    return this.codegen.save(b.id ?? null, b.version ?? null, b.config);
  }

  @Post('delete')
  @HttpCode(200)
  @Perms('dev:codegen:delete')
  @ApiOperation({
    operationId: 'devCodegenDelete',
    summary: '删除生成配置（不删已生成的代码）',
  })
  @ApiResult()
  @ApiErrors(400, 404)
  remove(@Body() b: IdBody) {
    return this.codegen.remove(b.id);
  }

  @Post('tables')
  @HttpCode(200)
  @Perms('dev:codegen:save')
  @ApiOperation({
    operationId: 'devCodegenTables',
    summary: '数据库里还没导入的表',
  })
  @ApiCodegenArray(SpecTable)
  @ApiErrors(401, 403)
  tables() {
    return this.codegen.tables();
  }

  @Post('import')
  @HttpCode(200)
  @Perms('dev:codegen:save')
  @ApiOperation({
    operationId: 'devCodegenImport',
    summary: '按表结构生成初始配置（不保存）',
  })
  @ApiResult()
  @ApiErrors(400, 404)
  importTable(@Body() b: TableBody) {
    return this.codegen.importTable(b.table);
  }

  @Post('preview')
  @HttpCode(200)
  @Perms('dev:codegen:save')
  @ApiOperation({
    operationId: 'devCodegenPreview',
    summary: '预览要生成的文件和每个文件的处理方式',
  })
  @ApiResult()
  @ApiErrors(400, 404)
  preview(@Body() b: IdBody) {
    return this.codegen.preview(b.id);
  }

  @Post('write')
  @HttpCode(200)
  @Perms('dev:codegen:write', { risk: 'high' })
  @ApiOperation({
    operationId: 'devCodegenWrite',
    summary: '确认写入本机项目（只写文件，不执行命令）',
  })
  @ApiResult()
  @ApiErrors(400, 404, 409)
  write(@Body() b: WriteBody) {
    return this.codegen.write(b.id, b.token, b.overwrite ?? []);
  }

  @Post('download')
  @HttpCode(200)
  @RawResponse()
  @Perms('dev:codegen:save')
  @ApiOperation({
    operationId: 'devCodegenDownload',
    summary: '下载生成的代码压缩包',
  })
  @ApiBinaryResult('application/zip', '代码压缩包')
  @ApiErrors(400, 404)
  async download(@Body() b: IdBody) {
    const { name, zip } = await this.codegen.download(b.id);
    return new StreamableFile(Buffer.from(zip), {
      type: 'application/zip',
      disposition: `attachment; filename="${name}"`,
    });
  }

  @Post('sync')
  @HttpCode(200)
  @Perms('dev:codegen:save')
  @ApiOperation({
    operationId: 'devCodegenSync',
    summary: '表结构和配置的差异',
  })
  @ApiResult()
  @ApiErrors(400, 404)
  sync(@Body() b: IdBody) {
    return this.codegen.sync(b.id);
  }
}
