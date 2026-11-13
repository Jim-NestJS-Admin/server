import { Body, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { Perms } from '../../../../core/permission/perms.decorator.js';
import { ApiErrors, ApiResult } from '../../../../core/swagger/api-result.js';
import {
  CreateFormBody,
  FormDesignerDto,
  FormFieldDto,
  FormValidationResult,
  ReviseFormBody,
  ValidateFormBody,
} from '../../dto/form.dto.js';
import { FormDefinition } from '../../entity/form-definition.entity.js';
import { FormDefinitionService } from '../../service/form-definition.service.js';
import { parseFormDesigner } from '../../service/form-rules.js';

class InspectFormBody {
  @ApiProperty({ type: FormDesignerDto })
  @IsObject()
  designer!: FormDesignerDto;
}
class InspectFormResult {
  @ApiProperty({ type: FormDesignerDto }) designer!: FormDesignerDto;
  @ApiProperty({ type: [FormFieldDto] }) fields!: FormFieldDto[];
}

@CrudController({
  prefix: 'form/definition',
  label: '表单定义',
  entity: FormDefinition,
  service: FormDefinitionService,
  api: ['page', 'info'],
  pageQuery: {
    keyWords: ['code', 'name'],
    fieldEq: ['code', 'revision'],
    defaultSort: [{ field: 'revision', order: 'desc' }],
  },
})
export class FormDefinitionController extends BaseController<FormDefinition> {
  constructor(private readonly definitions: FormDefinitionService) {
    super();
  }

  @Post('add')
  @HttpCode(200)
  @Perms('form:definition:add')
  @ApiOperation({
    operationId: 'formDefinitionAdd',
    summary: '创建表单第一版快照',
  })
  @ApiBody({ type: CreateFormBody })
  @ApiResult(FormDefinition)
  @ApiErrors(400, 403)
  create(@Body() body: CreateFormBody) {
    return this.definitions.createDefinition(body.data);
  }

  @Post('revise')
  @HttpCode(200)
  @Perms('form:definition:update')
  @ApiOperation({
    operationId: 'formDefinitionRevise',
    summary: '追加表单修订，旧版本不可变',
  })
  @ApiBody({ type: ReviseFormBody })
  @ApiResult(FormDefinition)
  @ApiErrors(400, 403, 404, 409)
  revise(@Body() body: ReviseFormBody) {
    return this.definitions.reviseDefinition(
      body.data,
      body.baseRevision,
      body.definitionId,
    );
  }

  @Post('inspect')
  @HttpCode(200)
  @Perms('form:definition:info')
  @ApiOperation({
    operationId: 'formDefinitionInspect',
    summary: '校验设计并解析字段清单，不保存',
  })
  @ApiBody({ type: InspectFormBody })
  @ApiResult(InspectFormResult)
  @ApiErrors(400, 403)
  inspect(@Body() body: InspectFormBody) {
    return parseFormDesigner(body.designer);
  }

  @Post('validate')
  @HttpCode(200)
  @Perms('form:definition:validate')
  @ApiOperation({
    operationId: 'formDefinitionValidate',
    summary: '按固定表单版本校验提交值，不保存业务数据',
  })
  @ApiBody({ type: ValidateFormBody })
  @ApiResult(FormValidationResult)
  @ApiErrors(400, 403, 404)
  validate(@Body() body: ValidateFormBody) {
    return this.definitions.validateSubmission(body.definitionId, body.data);
  }
}
