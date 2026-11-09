import { Column, Entity, Index } from 'typeorm';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
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
import type {
  DataScopeKind,
  MenuNode,
} from '../../../core/permission/permission-source.js';

@Entity('sys_user')
@Index(['tenantId', 'username', 'activeGuard'], { unique: true })
export class SystemUser extends BaseEntity {
  @CrudField({
    label: '账号',
    edit: 'add',
    list: { sortable: true },
    form: { required: true },
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @Matches(/^[a-z][a-z0-9_.-]{2,63}$/)
  @Column({ type: 'varchar', length: 64 })
  username: string;
  // 只允许密码专用入口写入，不声明为CRUD字段，不进入接口文档或详情。
  @Column({ type: 'varchar', length: 100, select: false }) passwordHash: string;
  @CrudField({ label: '姓名', form: { required: true } })
  @IsString()
  @Length(1, 100)
  @Column({ type: 'varchar', length: 100 })
  nickname: string;
  @CrudField({ label: '头像', nullable: true, list: false })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  @Column({ type: 'varchar', length: 500, nullable: true })
  avatar: string | null;
  @CrudField({ label: '启用', form: { component: 'switch' } })
  @IsBoolean()
  @Column({ type: 'boolean', default: true })
  enabled: boolean;
  @CrudField({ label: '语言' })
  @IsIn(['zh-CN', 'en'])
  @Column({ type: 'varchar', length: 16, default: 'zh-CN' })
  locale: string;
  @ApiProperty({ type: String, nullable: true })
  @CrudField({ label: '默认组织', nullable: true })
  @IsOptional()
  @Matches(ID_PATTERN)
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  defaultOrgId: string | null;
}

@Entity('sys_org')
export class SystemOrg extends BaseEntity {
  @CrudField({ label: '组织名称', form: { required: true } })
  @IsString()
  @Length(1, 100)
  @Column({ type: 'varchar', length: 100 })
  name: string;
  @ApiProperty({ type: String, nullable: true })
  @CrudField({ label: '上级组织', nullable: true })
  @IsOptional()
  @Matches(ID_PATTERN)
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  parentId: string | null;
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

@Entity('sys_role')
@Index(['tenantId', 'code', 'activeGuard'], { unique: true })
export class SystemRole extends BaseEntity {
  @CrudField({ label: '角色标识', edit: 'add', form: { required: true } })
  @Matches(/^[a-z][a-z0-9_-]{1,63}$/)
  @Column({ type: 'varchar', length: 64 })
  code: string;
  @CrudField({ label: '角色名称', form: { required: true } })
  @IsString()
  @Length(1, 100)
  @Column({ type: 'varchar', length: 100 })
  name: string;
  @CrudField({ label: '启用', form: { component: 'switch' } })
  @IsBoolean()
  @Column({ type: 'boolean', default: true })
  enabled: boolean;
  @CrudField({ label: '内置超级管理员', edit: 'none', form: false })
  @Column({ type: 'boolean', default: false })
  allPermissions: boolean;
  @ApiProperty({ type: [String] })
  @CrudField({ label: '权限码', list: false, form: { required: true } })
  @IsArray()
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsString({ each: true })
  @Column({ type: 'json' })
  permissions: string[];
  @CrudField({
    label: '数据范围',
    form: { component: 'select', required: true },
    dict: [
      { value: 'all', label: '全部' },
      { value: 'org', label: '本组织' },
      { value: 'org_and_children', label: '本组织及下级' },
      { value: 'self', label: '仅本人' },
      { value: 'custom', label: '自定义组织' },
    ],
  })
  @IsIn(['all', 'org', 'org_and_children', 'self', 'custom'])
  @Column({ type: 'varchar', length: 24 })
  dataScope: DataScopeKind;
  @ApiProperty({ type: [String] })
  @CrudField({ label: '自定义组织', list: false })
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @Matches(ID_PATTERN, { each: true })
  @Column({ type: 'json' })
  customOrgIds: string[];
}

@Entity('sys_user_role')
@Index(['tenantId', 'userId', 'roleId', 'scopeGuard', 'activeGuard'], {
  unique: true,
})
export class SystemUserRole extends BaseEntity {
  @Column({
    type: 'bigint',
    nullable: true,
    generatedType: 'STORED',
    asExpression: 'IFNULL(`scope_org_id`, 0)',
    insert: false,
    update: false,
    select: false,
  })
  scopeGuard: string;
  @CrudField({ label: '用户', edit: 'add', form: { required: true } })
  @Matches(ID_PATTERN)
  @Column({ type: 'bigint', unsigned: true })
  userId: string;
  @CrudField({ label: '角色', form: { required: true } })
  @Matches(ID_PATTERN)
  @Column({ type: 'bigint', unsigned: true })
  roleId: string;
  @ApiProperty({ type: String, nullable: true })
  @CrudField({ label: '作用范围组织', nullable: true })
  @IsOptional()
  @Matches(ID_PATTERN)
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  scopeOrgId: string | null;
}

@Entity('sys_menu')
export class SystemMenu extends BaseEntity {
  @ApiProperty({ type: String, nullable: true })
  @CrudField({ label: '上级菜单', nullable: true })
  @IsOptional()
  @Matches(ID_PATTERN)
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  parentId: string | null;
  @ApiProperty({ enum: ['directory', 'page', 'button'] })
  @CrudField({
    label: '类型',
    form: { required: true },
    dict: [
      { value: 'directory', label: '目录' },
      { value: 'page', label: '页面' },
      { value: 'button', label: '按钮' },
    ],
  })
  @IsIn(['directory', 'page', 'button'])
  @Column({ type: 'varchar', length: 16 })
  type: MenuNode['type'];
  @CrudField({ label: '路径' })
  @Matches(/^(?:|\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/)
  @Length(0, 200)
  @Column({ type: 'varchar', length: 200 })
  path: string;
  @CrudField({ label: '标题', form: { required: true } })
  @IsString()
  @Length(1, 100)
  @Column({ type: 'varchar', length: 100 })
  title: string;
  @CrudField({ label: '图标', nullable: true })
  @IsOptional()
  @IsString()
  @Length(0, 100)
  @Column({ type: 'varchar', length: 100, nullable: true })
  icon: string | null;
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
  @CrudField({ label: '页面组件', nullable: true })
  @IsOptional()
  @Matches(/^[A-Za-z][A-Za-z0-9_/-]{0,199}$/)
  @Column({ type: 'varchar', length: 200, nullable: true })
  component: string | null;
  @CrudField({ label: '权限码', nullable: true })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*){2,}$/)
  @Length(1, 200)
  @Column({ type: 'varchar', length: 200, nullable: true })
  permission: string | null;
  @CrudField({ label: '缓存页面', form: { component: 'switch' } })
  @IsBoolean()
  @Column({ type: 'boolean', default: false })
  keepAlive: boolean;
  @CrudField({ label: '隐藏', form: { component: 'switch' } })
  @IsBoolean()
  @Column({ type: 'boolean', default: false })
  hidden: boolean;
}

@Entity('sys_user_supervisor')
@Index(['tenantId', 'userId', 'supervisorId', 'activeGuard'], { unique: true })
export class SystemUserSupervisor extends BaseEntity {
  @CrudField({ label: '用户', edit: 'add', form: { required: true } })
  @Matches(ID_PATTERN)
  @Column({ type: 'bigint', unsigned: true })
  userId: string;
  @CrudField({ label: '上级用户', form: { required: true } })
  @Matches(ID_PATTERN)
  @Column({ type: 'bigint', unsigned: true })
  supervisorId: string;
}

export const SYSTEM_ENTITIES = [
  SystemUser,
  SystemOrg,
  SystemRole,
  SystemUserRole,
  SystemMenu,
  SystemUserSupervisor,
];
