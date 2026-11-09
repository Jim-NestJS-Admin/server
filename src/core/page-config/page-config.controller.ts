import { Body, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { AdminController } from '../endpoint/endpoint.decorators.js';
import { Perms } from '../permission/perms.decorator.js';
import { ApiErrors, ApiResult } from '../swagger/api-result.js';
import { PageConfigService } from './page-config.service.js';

const RESOURCE = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/;
const ID = /^[1-9]\d{0,19}$/;

class ResourceQuery {
  @ApiProperty({ example: 'system:user', description: '资源（权限码前缀）' })
  @Matches(RESOURCE)
  resource!: string;
}
class SaveBody extends ResourceQuery {
  @ApiProperty({ description: '读到的版本，没配置过时是 0' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;
  @ApiProperty({
    description: '配置内容（契约 page-config.md 第 2 节）',
    type: Object,
  })
  @IsObject()
  config!: object;
}
class VersionBody extends ResourceQuery {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(0) version!: number;
}
class HistoryBody extends ResourceQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size?: number;
}
class HistoryInfoBody extends ResourceQuery {
  @ApiProperty() @Matches(ID) historyId!: string;
}
class RestoreBody extends HistoryInfoBody {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(0) version!: number;
}

/** 在线页面配置（T23）：只改显示；权限码只给管理员 */
@ApiTags('system 模块配置')
@ApiBearerAuth()
@AdminController('system/page-config')
export class PageConfigController {
  constructor(private readonly configs: PageConfigService) {}

  @Get()
  @Perms('system:page-config:info')
  @ApiOperation({
    operationId: 'systemPageConfigInfo',
    summary: '模块显示配置',
  })
  @ApiResult()
  @ApiErrors(400, 403, 404)
  info(@Query() q: ResourceQuery) {
    return this.configs.get(q.resource);
  }

  @Post('save')
  @HttpCode(200)
  @Perms('system:page-config:update')
  @ApiOperation({
    operationId: 'systemPageConfigSave',
    summary: '保存模块显示配置',
  })
  @ApiResult()
  @ApiErrors(400, 403, 404, 409)
  save(@Body() b: SaveBody) {
    return this.configs.save(b.resource, b.version, b.config);
  }

  @Post('reset')
  @HttpCode(200)
  @Perms('system:page-config:update')
  @ApiOperation({
    operationId: 'systemPageConfigReset',
    summary: '恢复代码默认',
  })
  @ApiResult()
  @ApiErrors(400, 403, 404, 409)
  reset(@Body() b: VersionBody) {
    return this.configs.save(b.resource, b.version, null);
  }

  @Post('history')
  @HttpCode(200)
  @Perms('system:page-config:info')
  @ApiOperation({ operationId: 'systemPageConfigHistory', summary: '修改历史' })
  @ApiResult()
  @ApiErrors(400, 403, 404)
  history(@Body() b: HistoryBody) {
    return this.configs.history(b.resource, b.page ?? 1, b.size ?? 20);
  }

  @Post('history-info')
  @HttpCode(200)
  @Perms('system:page-config:info')
  @ApiOperation({
    operationId: 'systemPageConfigHistoryInfo',
    summary: '历史版本内容',
  })
  @ApiResult()
  @ApiErrors(400, 403, 404)
  historyInfo(@Body() b: HistoryInfoBody) {
    return this.configs.historyInfo(b.resource, b.historyId);
  }

  @Post('restore')
  @HttpCode(200)
  @Perms('system:page-config:update')
  @ApiOperation({
    operationId: 'systemPageConfigRestore',
    summary: '恢复历史版本',
  })
  @ApiResult()
  @ApiErrors(400, 403, 404, 409)
  restore(@Body() b: RestoreBody) {
    return this.configs.restore(b.resource, b.historyId, b.version);
  }
}
