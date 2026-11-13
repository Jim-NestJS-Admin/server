import { Entity, Column, Index } from 'typeorm';
import { IsArray, IsIn, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BaseEntity, CrudField } from '../../../core/crud/index.js';
import type { Segment } from '../service/rule-config.js';

@Entity('sys_code_rule')
@Index('uk_code_rule_code', ['tenantId', 'code', 'activeGuard'], {
  unique: true,
})
export class CodeRule extends BaseEntity {
  @CrudField({ label: '规则编码', edit: 'add', form: { required: true } })
  @Matches(/^[a-z][a-z0-9_]{1,63}$/)
  @Column({ length: 64 })
  code!: string;
  @CrudField({ label: '规则名称', form: { required: true } })
  @IsString()
  @MaxLength(100)
  @Matches(/\S/)
  @Column({ length: 100 })
  name!: string;
  @CrudField({ label: '说明', form: { component: 'textarea' } })
  @IsString()
  @MaxLength(500)
  @Column({ length: 500, default: '' })
  description!: string;
  @CrudField({ label: '时区', form: { required: true } })
  @IsString()
  @MaxLength(64)
  @Column({ length: 64 })
  timezone!: string;
  @CrudField({
    label: '重置周期',
    dict: [
      { value: 'never', label: '不重置' },
      { value: 'year', label: '每年' },
      { value: 'month', label: '每月' },
      { value: 'day', label: '每天' },
    ],
    form: { required: true },
  })
  @IsIn(['never', 'year', 'month', 'day'])
  @Column({ length: 8 })
  resetPeriod!: string;
  @CrudField({ label: '编码段', list: false, form: { required: true } })
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  @IsArray()
  @Column({ type: 'json' })
  segments!: Segment[];
  @CrudField({ label: '起始值', form: { required: true } })
  @Matches(/^[1-9]\d{0,11}$/)
  @Column({ type: 'bigint', unsigned: true })
  start!: string;
  @CrudField({
    label: '状态',
    dict: [
      { value: 'enabled', label: '启用' },
      { value: 'disabled', label: '停用' },
    ],
    form: { required: true },
  })
  @IsIn(['enabled', 'disabled'])
  @Column({ length: 8 })
  status!: string;
  @CrudField({ label: '修订号', edit: 'none' })
  @Column({ type: 'int', unsigned: true, default: 1 })
  revision!: number;
  @CrudField({ label: '首次绑定时间', edit: 'none', list: false })
  @Column({ type: 'datetime', precision: 3, nullable: true })
  firstBoundAt!: Date | null;
  @CrudField({ label: '首次绑定用途', edit: 'none', list: false })
  @Column({ type: 'varchar', length: 64, nullable: true })
  firstBoundUsageKey!: string | null;
}
@Entity('sys_code_rule_version')
@Index('uk_code_rule_version', ['tenantId', 'ruleId', 'revision'], {
  unique: true,
})
export class CodeRuleVersion extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true }) ruleId!: string;
  @Column({ type: 'int', unsigned: true }) revision!: number;
  @Column({ type: 'json' }) snapshot!: object;
}
@Entity('sys_code_binding')
@Index('uk_code_binding_usage', ['tenantId', 'usageKey', 'activeGuard'], {
  unique: true,
})
@Index('uk_code_binding_rule', ['tenantId', 'ruleId', 'activeGuard'], {
  unique: true,
})
export class CodeBinding extends BaseEntity {
  @Column({ length: 64 }) usageKey!: string;
  @Column({ type: 'bigint', unsigned: true }) ruleId!: string;
}
@Entity('sys_code_sequence')
@Index('uk_code_sequence', ['tenantId', 'ruleId', 'periodKey'], {
  unique: true,
})
export class CodeSequence extends BaseEntity {
  @CrudField({ label: '规则编号', edit: 'none' })
  @Column({ type: 'bigint', unsigned: true })
  ruleId!: string;
  @CrudField({ label: '周期', edit: 'none' })
  @Column({ length: 10 })
  periodKey!: string;
  @CrudField({ label: '当前序号', edit: 'none' })
  @Column({ type: 'bigint', unsigned: true })
  current!: string;
  @CrudField({ label: '最近编码', edit: 'none' })
  @Column({ type: 'varchar', length: 64, nullable: true })
  lastCode!: string | null;
}
@Entity('sys_code_allocation')
@Index('uk_code_allocation', ['tenantId', 'usageKey', 'code'], { unique: true })
export class CodeAllocation extends BaseEntity {
  @Column({ length: 64 }) usageKey!: string;
  @Column({ type: 'bigint', unsigned: true }) ruleId!: string;
  @Column({ type: 'int', unsigned: true }) ruleRevision!: number;
  @Column({ length: 64, collation: 'utf8mb4_bin' }) code!: string;
  @Column({ type: 'bigint', unsigned: true }) sequenceValue!: string;
  @Column({ length: 10 }) periodKey!: string;
}
