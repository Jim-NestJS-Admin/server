import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index } from 'typeorm';
import { IsObject, IsString, Matches, MaxLength } from 'class-validator';
import { BaseEntity, CrudField } from '../../../core/crud/index.js';
import { FormDesignerDto, FormFieldDto } from '../dto/form.dto.js';

/** 每次修订追加一条不可变快照；version 为框架行版本，revision 为表单业务版本。 */
@Entity('form_definition')
@Index(
  'uk_form_definition_revision',
  ['tenantId', 'code', 'revision', 'activeGuard'],
  { unique: true },
)
export class FormDefinition extends BaseEntity {
  @CrudField({ label: '表单编码', generated: true, list: { sortable: true } })
  @Matches(/^[a-z][a-z0-9_]{1,63}$/)
  @Column({ type: 'varchar', length: 64 })
  code!: string;

  @CrudField({ label: '表单名称', edit: 'add' })
  @IsString()
  @MaxLength(100)
  @Matches(/\S/)
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @CrudField({ label: '表单版本', edit: 'none', list: { sortable: true } })
  @Column({ type: 'int', unsigned: true })
  revision!: number;

  @ApiProperty({ type: FormDesignerDto })
  @CrudField({ label: '表单设计', edit: 'add', list: false })
  @IsObject()
  @Column({ type: 'json' })
  designer!: FormDesignerDto;

  @ApiProperty({ type: [FormFieldDto] })
  @CrudField({ label: '字段清单', edit: 'none', list: false })
  @Column({ type: 'json' })
  fields!: FormFieldDto[];
}
