import { Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { CrudRuntime } from '../crud/crud.runtime.js';
import { SYSTEM_FIELDS } from '../crud/base.entity.js';
import { AdminController } from '../endpoint/endpoint.decorators.js';
import { Perms } from '../permission/perms.decorator.js';
import { ApiErrors, ApiResult } from '../swagger/api-result.js';
import { fieldPermOf } from './field-perm.decorator.js';
import { MASK_RULES } from './masks.js';

const SYSTEM = new Set<string>([...SYSTEM_FIELDS, 'version', 'deletedAt']);
const STATES = ['editable', 'readonly', 'masked', 'hidden'];
const MASKS = ['phone', 'email', 'idcard', 'last4', 'all'];

class FieldPermFieldDto {
  @ApiProperty({ description: '实体属性名' }) field!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: STATES, description: '代码默认状态' }) default!: string;
  @ApiProperty({ enum: MASKS, nullable: true, type: String }) mask!:
    string | null;
  @ApiProperty({
    enum: STATES,
    nullable: true,
    type: String,
    description: '可委派上限',
  })
  delegable!: string | null;
  @ApiProperty() configurable!: boolean;
}

class FieldPermResourceDto {
  @ApiProperty({ description: '资源（权限码前缀），如 system:user' })
  resource!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ type: [FieldPermFieldDto] }) fields!: FieldPermFieldDto[];
}

class MaskRuleDto {
  @ApiProperty({ enum: MASKS }) code!: string;
  @ApiProperty() label!: string;
}

class FieldPermRegistryDto {
  @ApiProperty({ type: [FieldPermResourceDto] })
  resources!: FieldPermResourceDto[];
  @ApiProperty({ type: [MaskRuleDto] }) masks!: MaskRuleDto[];
}

/**
 * 字段权限清单（契约 field-perm.md 第 3 节）：启动时注册的全部 CRUD 资源的业务字段和代码默认值。
 * 后台改过的默认值在 sys_field，由 T07 的管理接口提供；前端两者合并展示。
 */
@ApiTags('system 字段权限')
@ApiBearerAuth()
@AdminController('system/field-perm')
export class FieldPermRegistryController {
  constructor(private readonly crud: CrudRuntime) {}

  @Get('registry')
  @Perms('system:field:list')
  @ApiOperation({
    operationId: 'systemFieldPermRegistry',
    summary: '字段权限清单（代码默认值）',
  })
  @ApiResult(FieldPermRegistryDto)
  @ApiErrors(401, 403, 503)
  registry(): FieldPermRegistryDto {
    return {
      resources: this.crud.list().map((meta) => ({
        resource: meta.permPrefix,
        label: meta.label,
        fields: meta.fields
          .filter((f) => !SYSTEM.has(f.property))
          .map((f) => {
            const code = fieldPermOf(meta.entity, f.property);
            return {
              field: f.property,
              label: code?.label ?? f.label ?? f.property,
              default: code?.default ?? 'editable',
              mask: code?.mask ?? null,
              delegable: code?.delegable ?? null,
              configurable: code?.configurable ?? true,
            };
          })
          .filter((f) => f.configurable),
      })),
      masks: MASK_RULES,
    };
  }
}
