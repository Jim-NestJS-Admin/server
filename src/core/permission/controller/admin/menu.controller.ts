import { Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { AdminController } from '../../../endpoint/endpoint.decorators.js';
import { ApiErrors, ApiResult } from '../../../swagger/api-result.js';
import { PermissionService } from '../../permission.service.js';
import { LoginOnly } from '../../perms.decorator.js';

class MenuItemDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['directory', 'page'] }) type!: 'directory' | 'page';
  @ApiProperty() path!: string;
  @ApiProperty({ description: '后台配置的显示名' }) title!: string;
  @ApiProperty({ type: String, nullable: true }) icon!: string | null;
  @ApiProperty() rank!: number;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: '前端页面相对路径，只认本地白名单',
  })
  component?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  permission?: string | null;
  @ApiPropertyOptional() keepAlive?: boolean;
  @ApiPropertyOptional() hidden?: boolean;
  @ApiPropertyOptional({ type: () => [MenuItemDto] })
  children?: MenuItemDto[];
}

class MenuResult {
  @ApiProperty({ type: [MenuItemDto], description: '菜单树，不含按钮' })
  menus!: MenuItemDto[];
  @ApiProperty({
    type: [String],
    description: '当前组织下的权限码，明确列表，没有通配符',
  })
  permissions!: string[];
  @ApiProperty({ description: '授权版本，只用来判断权限变了没有' })
  authVersion!: number;
}

/** 当前用户的菜单和权限码（契约 sessionMenu）。切换组织后重新获取 */
@ApiTags('auth 登录认证')
@ApiBearerAuth()
@LoginOnly()
@AdminController('session')
export class MenuController {
  constructor(private readonly permissions: PermissionService) {}

  @Get('menu')
  @ApiOperation({ operationId: 'sessionMenu', summary: '菜单树和权限码' })
  @ApiResult(MenuResult)
  @ApiErrors(401, 503)
  menu() {
    return this.permissions.menu();
  }
}
