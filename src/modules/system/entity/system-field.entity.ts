import { Column, Entity, Index } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, Matches } from 'class-validator';
import { BaseEntity } from '../../../core/crud/base.entity.js';
import { CrudField } from '../../../core/crud/crud-field.decorator.js';
import { ID_PATTERN } from '../../../core/crud/crud.dto.js';
import {
  FieldPerm,
  type FieldState,
  type MaskRule,
} from '../../../core/field-perm/field-perm.decorator.js';

export const FIELD_STATES = [
  'editable',
  'readonly',
  'masked',
  'hidden',
] as const;
export const FIELD_MASKS = [
  'phone',
  'email',
  'idcard',
  'last4',
  'all',
] as const;
/** 安全配置自身不能再被字段配置隐藏或改成不可编辑，以免锁死管理入口。 */
export abstract class SystemFieldRule extends BaseEntity {
  @CrudField({ label: '资源', edit: 'add', form: { required: true } })
  @FieldPerm({ configurable: false })
  @Matches(/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/)
  @Column({ type: 'varchar', length: 160 })
  resource: string;

  @CrudField({ label: '字段', edit: 'add', form: { required: true } })
  @FieldPerm({ configurable: false })
  @Matches(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
  @Column({ type: 'varchar', length: 64 })
  field: string;

  @CrudField({
    label: '状态',
    dict: FIELD_STATES.map((value) => ({ value, label: value })),
    form: { required: true },
  })
  @FieldPerm({ configurable: false })
  @IsIn(FIELD_STATES)
  @Column({ type: 'varchar', length: 16 })
  state: FieldState;

  @ApiProperty({ enum: FIELD_MASKS, nullable: true })
  @CrudField({
    label: '脱敏规则',
    nullable: true,
    dict: FIELD_MASKS.map((value) => ({ value, label: value })),
  })
  @FieldPerm({ configurable: false })
  @IsOptional()
  @IsIn(FIELD_MASKS)
  @Column({ type: 'varchar', length: 16, nullable: true })
  mask: MaskRule | null;
}

@Entity('sys_field')
@Index(['tenantId', 'resource', 'field', 'activeGuard'], { unique: true })
export class SystemField extends SystemFieldRule {
  @ApiProperty({ enum: FIELD_STATES, nullable: true })
  @CrudField({
    label: '可委派上限',
    nullable: true,
    dict: FIELD_STATES.map((value) => ({ value, label: value })),
  })
  @FieldPerm({ configurable: false })
  @IsOptional()
  @IsIn(FIELD_STATES)
  @Column({ type: 'varchar', length: 16, nullable: true })
  delegable: FieldState | null;

  @CrudField({ label: '允许配置', edit: 'none' })
  @FieldPerm({ configurable: false })
  @Column({ type: 'boolean', default: true })
  configurable: boolean;

  @CrudField({ label: '启用' })
  @FieldPerm({ configurable: false })
  @IsBoolean()
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @CrudField({ label: '来源', edit: 'none' })
  @FieldPerm({ configurable: false })
  @Column({ type: 'varchar', length: 16, default: 'admin' })
  source: string;
}

@Entity('sys_role_field')
@Index(['tenantId', 'roleId', 'resource', 'field', 'activeGuard'], {
  unique: true,
})
export class SystemRoleField extends SystemFieldRule {
  @ApiProperty({ type: String })
  @CrudField({ label: '角色', edit: 'add', form: { required: true } })
  @FieldPerm({ configurable: false })
  @Matches(ID_PATTERN)
  @Column({ type: 'bigint', unsigned: true })
  roleId: string;
}
