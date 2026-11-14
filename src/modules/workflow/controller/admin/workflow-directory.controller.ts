import { Body, HttpCode, Post } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsArray,
  ArrayMaxSize,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AdminController } from '../../../../core/endpoint/endpoint.decorators.js';
import { Perms } from '../../../../core/permission/perms.decorator.js';
import { ApiResult } from '../../../../core/swagger/api-result.js';
import { SystemDirectory } from '../../../system/service/system-directory.service.js';

class WorkflowDirectoryBody {
  @ApiPropertyOptional({ type: [String], maxItems: 50 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @Matches(/^[1-9]\d{0,19}$/, { each: true })
  ids?: string[];
  @ApiProperty({ enum: ['users', 'roles', 'orgs'] })
  @IsIn(['users', 'roles', 'orgs'])
  kind!: 'users' | 'roles' | 'orgs';
  @ApiPropertyOptional({ default: '' })
  @IsOptional()
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
class WorkflowDirectoryOption {
  @ApiProperty() id!: string;
  @ApiProperty() label!: string;
}
class WorkflowDirectoryResult {
  @ApiProperty({ type: [WorkflowDirectoryOption] })
  list!: WorkflowDirectoryOption[];
  @ApiProperty() total!: number;
}
/** 审批选人专用最小目录，不返回账号、联系方式、角色权限或其他业务字段。 */
@AdminController('workflow/directory')
export class WorkflowDirectoryController {
  constructor(private readonly directory: SystemDirectory) {}
  @Post('page')
  @HttpCode(200)
  @Perms('workflow:directory:page')
  @ApiOperation({
    operationId: 'workflowDirectoryPage',
    summary: '按租户搜索审批成员、角色及组织的编号和显示名',
  })
  @ApiBody({ type: WorkflowDirectoryBody })
  @ApiResult(WorkflowDirectoryResult)
  page(@Body() body: WorkflowDirectoryBody) {
    return this.directory.workflowChoices(
      body.kind,
      body.keyword,
      body.page,
      body.size,
      body.ids,
    );
  }
}
