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
  IsBoolean,
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
  @ApiPropertyOptional({
    description: '按成员的组织角色归属筛选，仅用于成员目录',
  })
  @IsOptional()
  @Matches(/^[1-9]\d{0,19}$/)
  orgId?: string;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  includeChildren: boolean = false;
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
class WorkflowDirectoryOrganization extends WorkflowDirectoryOption {
  @ApiProperty({ type: String, nullable: true }) parentId!: string | null;
}
class WorkflowDirectoryOrganizations {
  @ApiProperty({ type: [WorkflowDirectoryOrganization] })
  list!: WorkflowDirectoryOrganization[];
}
/** 审批选人专用最小目录，不返回账号、联系方式、角色权限或其他业务字段。 */
@AdminController('workflow/directory')
export class WorkflowDirectoryController {
  constructor(private readonly directory: SystemDirectory) {}
  @Post('organizations')
  @HttpCode(200)
  @Perms('workflow:directory:page')
  @ApiOperation({
    operationId: 'workflowDirectoryOrganizations',
    summary: '成员选择器的同租户启用组织树，只返回编号、名称和父级',
  })
  @ApiResult(WorkflowDirectoryOrganizations)
  async organizations() {
    return { list: await this.directory.workflowOrganizations() };
  }
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
      body.orgId,
      body.includeChildren,
    );
  }
}
