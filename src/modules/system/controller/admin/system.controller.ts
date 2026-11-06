import { Body, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { BaseController } from '../../../../core/crud/base.controller.js';
import { CrudController } from '../../../../core/crud/crud-controller.decorator.js';
import { AdminController } from '../../../../core/endpoint/endpoint.decorators.js';
import {
  LoginOnly,
  Perms,
} from '../../../../core/permission/perms.decorator.js';
import { PermissionRegistry } from '../../../../core/permission/permission-registry.js';
import { RequestContext } from '../../../../core/tenant/request-context.js';
import { ApiErrors, ApiResult } from '../../../../core/swagger/api-result.js';
import {
  SystemUser,
  SystemRole,
  SystemOrg,
  SystemMenu,
  SystemUserRole,
  SystemUserSupervisor,
} from '../../entity/system.entity.js';
import {
  SystemUserService,
  SystemRoleService,
  SystemOrgService,
  SystemMenuService,
  SystemUserRoleService,
  SystemSupervisorService,
} from '../../service/system-management.service.js';
import {
  CreateSystemUser,
  ChangeSystemPassword,
  ResetSystemPassword,
  SystemMutationResult,
} from '../../dto/system.dto.js';

/** 权限与组织配置的增改同样声明高风险，不只依赖通用删除的默认值。 */
function sensitiveWrites(prefix: string): ClassDecorator {
  return (target) => {
    for (const method of ['add', 'update', 'delete']) {
      const descriptor = Object.getOwnPropertyDescriptor(
        target.prototype,
        method,
      );
      if (descriptor)
        Perms(`${prefix}:${method}`, { risk: 'high' })(
          target.prototype,
          method,
          descriptor,
        );
    }
  };
}

@sensitiveWrites('system:user')
@CrudController({
  prefix: 'system/user',
  label: '用户',
  entity: SystemUser,
  service: SystemUserService,
  api: ['page', 'info', 'update', 'delete'],
  pageQuery: {
    keyWords: ['username', 'nickname'],
    fieldEq: ['enabled', 'defaultOrgId'],
  },
})
export class SystemUserController extends BaseController<SystemUser> {
  constructor(
    private readonly users: SystemUserService,
    private readonly context: RequestContext,
  ) {
    super();
  }
  @Post('create')
  @HttpCode(200)
  @Perms('system:user:add', { risk: 'high' })
  @ApiOperation({
    operationId: 'systemUserCreate',
    summary: '创建用户并设置初始密码',
  })
  @ApiBody({ type: CreateSystemUser })
  @ApiResult(SystemMutationResult)
  @ApiErrors(400, 403)
  create(@Body() body: CreateSystemUser) {
    return this.users.create(body);
  }

  @Post('reset-password')
  @HttpCode(200)
  @Perms('system:user:reset-password', { risk: 'high' })
  @ApiOperation({
    operationId: 'systemUserResetPassword',
    summary: '管理员重置密码并吊销用户会话',
  })
  @ApiBody({ type: ResetSystemPassword })
  @ApiResult(SystemMutationResult)
  @ApiErrors(400, 403, 404, 409)
  resetPassword(@Body() body: ResetSystemPassword) {
    return this.users.setPassword(body.id, body.version, body.password);
  }

  @Post('change-password')
  @HttpCode(200)
  @LoginOnly()
  @ApiOperation({
    operationId: 'systemUserChangePassword',
    summary: '修改本人密码，核对原密码并吊销旧会话',
  })
  @ApiBody({ type: ChangeSystemPassword })
  @ApiResult(SystemMutationResult)
  @ApiErrors(400, 401, 409)
  changePassword(@Body() body: ChangeSystemPassword) {
    return this.users.setPassword(
      this.context.current().userId!,
      body.version,
      body.password,
      body.oldPassword,
    );
  }
}

@sensitiveWrites('system:role')
@CrudController({
  prefix: 'system/role',
  label: '角色',
  entity: SystemRole,
  service: SystemRoleService,
  api: ['page', 'info', 'add', 'update', 'delete'],
  pageQuery: { keyWords: ['code', 'name'], fieldEq: ['enabled'] },
})
export class SystemRoleController extends BaseController<SystemRole> {}

@sensitiveWrites('system:org')
@CrudController({
  prefix: 'system/org',
  label: '组织',
  entity: SystemOrg,
  service: SystemOrgService,
  api: ['page', 'info', 'add', 'update', 'delete'],
  pageQuery: {
    keyWords: ['name'],
    fieldEq: ['parentId', 'enabled'],
    defaultSort: [{ field: 'rank', order: 'asc' }],
  },
})
export class SystemOrgController extends BaseController<SystemOrg> {}

@sensitiveWrites('system:menu')
@CrudController({
  prefix: 'system/menu',
  label: '菜单',
  entity: SystemMenu,
  service: SystemMenuService,
  api: ['page', 'info', 'add', 'update', 'delete'],
  pageQuery: {
    keyWords: ['title', 'path'],
    fieldEq: ['parentId', 'type'],
    defaultSort: [{ field: 'rank', order: 'asc' }],
  },
})
export class SystemMenuController extends BaseController<SystemMenu> {}

@sensitiveWrites('system:user-role')
@CrudController({
  prefix: 'system/user-role',
  label: '用户组织角色分配',
  entity: SystemUserRole,
  service: SystemUserRoleService,
  api: ['page', 'info', 'add', 'update', 'delete'],
  pageQuery: { fieldEq: ['userId', 'roleId', 'scopeOrgId'] },
})
export class SystemUserRoleController extends BaseController<SystemUserRole> {}

@sensitiveWrites('system:user-supervisor')
@CrudController({
  prefix: 'system/user-supervisor',
  label: '用户多上级',
  entity: SystemUserSupervisor,
  service: SystemSupervisorService,
  api: ['page', 'info', 'add', 'update', 'delete'],
  pageQuery: { fieldEq: ['userId', 'supervisorId'] },
})
export class SystemSupervisorController extends BaseController<SystemUserSupervisor> {}

class PermissionItem {
  @ApiProperty() code: string;
  @ApiProperty({ enum: ['normal', 'high'] }) risk: 'normal' | 'high';
}
class PermissionList {
  @ApiProperty({ type: [PermissionItem] }) list: PermissionItem[];
}
@AdminController('system/permission')
export class SystemPermissionController {
  constructor(private readonly registry: PermissionRegistry) {}
  @Get('list')
  @Perms('system:role:info')
  @ApiResult(PermissionList)
  @ApiOperation({
    operationId: 'systemPermissionList',
    summary: '后端已声明权限码及风险级别',
  })
  list() {
    return { list: this.registry.all() };
  }
}
