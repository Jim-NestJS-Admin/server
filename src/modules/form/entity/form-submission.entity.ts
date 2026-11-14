import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index } from 'typeorm';
import { IsObject, Matches } from 'class-validator';
import { BaseEntity, CrudField } from '../../../core/crud/index.js';
import { FieldPerm } from '../../../core/field-perm/field-perm.decorator.js';

/** 一次正式提交引用不可变表单版本；后续流程引用本记录，不复制填写数据。 */
@Entity('form_submission')
@Index('idx_form_submission_definition', ['tenantId', 'definitionId'])
export class FormSubmission extends BaseEntity {
  @CrudField({ label: '表单版本编号', edit: 'add' })
  @Matches(/^[1-9]\d{0,19}$/)
  @Column({ type: 'bigint', unsigned: true })
  definitionId!: string;

  @CrudField({ label: '表单名称', edit: 'none' })
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @CrudField({ label: '表单编码', edit: 'none' })
  @Column({ type: 'varchar', length: 64 })
  code!: string;

  @CrudField({ label: '表单版本', edit: 'none' })
  @Column({ type: 'int', unsigned: true })
  revision!: number;

  @ApiProperty({ type: 'object', additionalProperties: true })
  @CrudField({ label: '填写内容', edit: 'add', list: false })
  @FieldPerm({ label: '填写内容', default: 'editable', delegable: 'editable' })
  @IsObject()
  @Column({ type: 'json' })
  values!: Record<string, unknown>;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  @CrudField({ label: '字段名称', edit: 'none', list: false, form: false })
  @Column({ type: 'json' })
  fieldTitles!: Record<string, string>;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  @CrudField({ label: '自动编号', edit: 'none' })
  @Column({ type: 'json' })
  codes!: Record<string, string>;
}
