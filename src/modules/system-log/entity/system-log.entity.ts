import { ApiHideProperty } from '@nestjs/swagger';
import { Column, Entity, Index } from 'typeorm';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { BaseEntity } from '../../../core/crud/base.entity.js';
import { CrudField } from '../../../core/crud/crud-field.decorator.js';
import { ID_PATTERN } from '../../../core/crud/crud.dto.js';

@Entity('sys_dict_type')
@Index(['tenantId', 'code', 'activeGuard'], { unique: true })
export class SystemDictType extends BaseEntity {
  @CrudField({ label: '内置', form: { component: 'switch' } })
  @IsOptional()
  @IsBoolean()
  @Column({ type: 'boolean', default: false })
  builtin: boolean;
  @CrudField({
    label: '排序',
    list: { sortable: true },
    form: { component: 'number' },
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000)
  @Column({ type: 'int', default: 0 })
  rank: number;
  @CrudField({ label: '字典标识', form: { required: true } })
  @Matches(/^[a-z][a-z0-9_.-]{1,63}$/)
  @Column({ type: 'varchar', length: 64 })
  code: string;
  @CrudField({ label: '字典名称', form: { required: true } })
  @IsString()
  @Length(1, 100)
  @Column({ type: 'varchar', length: 100 })
  name: string;
  @CrudField({ label: '启用', form: { component: 'switch' } })
  @IsBoolean()
  @Column({ type: 'boolean', default: true })
  enabled: boolean;
}
@Entity('sys_dict_item')
@Index(['tenantId', 'typeId', 'value', 'activeGuard'], { unique: true })
export class SystemDictItem extends BaseEntity {
  @CrudField({ label: '字典类型', edit: 'add', form: { required: true } })
  @Matches(ID_PATTERN)
  @Column({ type: 'bigint', unsigned: true })
  typeId: string;
  @CrudField({ label: '字典值', form: { required: true } })
  @IsString()
  @Length(1, 100)
  @Column({ type: 'varchar', length: 100 })
  value: string;
  @CrudField({ label: '显示名称', form: { required: true } })
  @IsString()
  @Length(1, 100)
  @Column({ type: 'varchar', length: 100 })
  label: string;
  @CrudField({ label: '启用', form: { component: 'switch' } })
  @IsBoolean()
  @Column({ type: 'boolean', default: true })
  enabled: boolean;
  @CrudField({
    label: '排序',
    list: { sortable: true },
    form: { component: 'number' },
  })
  @IsInt()
  @Min(0)
  @Max(1000000)
  @Column({ type: 'int', default: 0 })
  rank: number;
}
@Entity('sys_parameter')
@Index(['tenantId', 'key', 'activeGuard'], { unique: true })
export class SystemParameter extends BaseEntity {
  @CrudField({ label: '参数标识', edit: 'add', form: { required: true } })
  @Matches(/^[a-z][a-z0-9_.-]{1,127}$/)
  @Column({ type: 'varchar', length: 128 })
  key: string;
  @CrudField({ label: '参数值', form: { component: 'textarea' } })
  @IsString()
  @Length(0, 8000)
  @Column({ type: 'text' })
  value: string;
  @CrudField({ label: '说明', nullable: true })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;
}
@Entity('sys_operation_log')
@Index(['tenantId', 'createdAt'])
export class SystemOperationLog extends BaseEntity {
  @CrudField({ label: '动作', edit: 'none', form: false })
  @Column({ type: 'varchar', length: 200 })
  action: string;
  @CrudField({ label: '资源', edit: 'none', form: false })
  @Column({ type: 'varchar', length: 200 })
  resource: string;
  @CrudField({ label: '请求方法', edit: 'none', form: false })
  @Column({ type: 'varchar', length: 12 })
  method: string;
  @CrudField({ label: '成功', edit: 'none', form: false })
  @Column({ type: 'boolean' })
  success: boolean;
  @CrudField({ label: '状态码', edit: 'none', form: false })
  @Column({ type: 'int' })
  status: number;
  @CrudField({ label: '耗时毫秒', edit: 'none', form: false })
  @Column({ type: 'int', unsigned: true })
  durationMs: number;
  @CrudField({ label: '记录数', edit: 'none', form: false })
  @Column({ type: 'int', unsigned: true, default: 0 })
  recordCount: number;
  @CrudField({ label: '请求编号', edit: 'none', form: false })
  @Column({ type: 'varchar', length: 64, nullable: true })
  requestId: string | null;
  @ApiHideProperty()
  @Column({ type: 'json', nullable: true, select: false })
  snapshot: unknown;
}
@Entity('sys_login_log')
@Index(['tenantId', 'createdAt'])
export class SystemLoginLog extends BaseEntity {
  @CrudField({ label: '事件', edit: 'none', form: false })
  @Column({ type: 'varchar', length: 32 })
  event: string;
  @CrudField({ label: '账号', edit: 'none', form: false })
  @Column({ type: 'varchar', length: 64, nullable: true })
  username: string | null;
  @CrudField({ label: '结果', edit: 'none', form: false })
  @Column({ type: 'boolean' })
  success: boolean;
  @CrudField({ label: '原因', edit: 'none', form: false })
  @Column({ type: 'varchar', length: 40, nullable: true })
  reason: string | null;
  @ApiHideProperty()
  @Column({ type: 'varchar', length: 64, nullable: true, select: false })
  ip: string | null;
  @ApiHideProperty()
  @Column({ type: 'varchar', length: 500, nullable: true, select: false })
  userAgent: string | null;
  @ApiHideProperty()
  @Column({ type: 'char', length: 64, nullable: true, select: false })
  sessionHash: string | null;
}
export const SYSTEM_LOG_ENTITIES = [
  SystemDictType,
  SystemDictItem,
  SystemParameter,
  SystemOperationLog,
  SystemLoginLog,
];
