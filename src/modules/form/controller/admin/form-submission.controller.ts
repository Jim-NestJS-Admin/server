import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { FormSubmission } from '../../entity/form-submission.entity.js';
import { FormSubmissionService } from '../../service/form-submission.service.js';
import { Body, HttpCode, Post } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Perms } from '../../../../core/permission/perms.decorator.js';
import { ApiResult } from '../../../../core/swagger/api-result.js';
class MineSubmissionBody {
  @ApiProperty() @Matches(/^[1-9]\d{0,19}$/) definitionId!: string;
  @ApiPropertyOptional({ default: 1 })
  @IsInt()
  @Min(1)
  @Max(10000)
  page: number = 1;
  @ApiPropertyOptional({ default: 20 }) @IsInt() @Min(1) @Max(50) size: number =
    20;
  @ApiPropertyOptional({ default: '' })
  @IsString()
  @MaxLength(100)
  keyword: string = '';
}
class MineSubmissionResult {
  @ApiProperty({ type: [FormSubmission] }) list!: FormSubmission[];
  @ApiProperty() total!: number;
}
@CrudController({
  prefix: 'form/submission',
  label: '表单提交记录',
  entity: FormSubmission,
  service: FormSubmissionService,
  api: ['page', 'info', 'add'],
  dataScope: true,
  pageQuery: {
    keyWords: ['name', 'code'],
    fieldEq: ['definitionId', 'code', 'revision'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class FormSubmissionController extends BaseController<FormSubmission> {
  constructor(private readonly submissions: FormSubmissionService) {
    super();
  }
  @Post('mine')
  @HttpCode(200)
  @Perms('form:submission:page')
  @ApiOperation({
    operationId: 'formSubmissionMine',
    summary: '分页选择本人固定表单版本的提交，沿用数据和字段权限',
  })
  @ApiBody({ type: MineSubmissionBody })
  @ApiResult(MineSubmissionResult)
  mine(@Body() body: MineSubmissionBody) {
    return this.submissions.mineForWorkflow(body);
  }
}
