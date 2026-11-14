import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index } from 'typeorm';
import { IsObject, IsString, Matches, MaxLength } from 'class-validator';
import { BaseEntity, CrudField } from '../../../core/crud/index.js';
import { WorkflowDesignerDto } from '../dto/workflow.dto.js';

/** 配置按修订追加；发布只改变本行生命周期，不更新任何旧修订的设计/BPMN。 */
@Entity('wf_definition')
@Index(
  'uk_wf_definition_revision',
  ['tenantId', 'code', 'revision', 'activeGuard'],
  { unique: true },
)
export class WorkflowDefinition extends BaseEntity {
  @CrudField({ label: '流程编码', generated: true })
  @Matches(/^[a-z][a-z0-9_]{1,63}$/)
  @Column({ type: 'varchar', length: 64 })
  code!: string;
  @CrudField({ label: '流程名称', edit: 'add' })
  @IsString()
  @MaxLength(100)
  @Matches(/\S/)
  @Column({ length: 100 })
  name!: string;
  @CrudField({ label: '说明', edit: 'add' })
  @IsString()
  @MaxLength(500)
  @Column({ length: 500, default: '' })
  description!: string;
  @CrudField({ label: '流程版本', edit: 'none', list: { sortable: true } })
  @Column({ type: 'int', unsigned: true })
  revision!: number;
  @CrudField({ label: '固定表单版本', edit: 'add' })
  @Matches(/^[1-9]\d{0,19}$/)
  @Column({ type: 'bigint', unsigned: true })
  formDefinitionId!: string;
  @ApiProperty({ type: WorkflowDesignerDto })
  @CrudField({ label: '流程设计', edit: 'add', list: false })
  @IsObject()
  @Column({ type: 'json' })
  designer!: WorkflowDesignerDto;
  @CrudField({
    label: '状态',
    edit: 'none',
    dict: [
      { value: 'draft', label: '草稿', tagType: 'info' },
      { value: 'published', label: '已发布', tagType: 'success' },
    ],
  })
  @Column({ length: 16, default: 'draft' })
  status!: 'draft' | 'published';
  @CrudField({ label: 'BPMN', edit: 'none', list: false, form: false })
  @Column({ type: 'longtext' })
  bpmn!: string;
  @CrudField({ label: '编译摘要', edit: 'none', list: false })
  @Column({ type: 'char', length: 64 })
  digest!: string;
  @CrudField({ label: '编译器版本', edit: 'none', list: false })
  @Column({ type: 'int', unsigned: true, default: 1 })
  compilerVersion!: number;
  @CrudField({ label: '发布时间', edit: 'none', nullable: true })
  @Column({ type: 'datetime', precision: 3, nullable: true })
  publishedAt!: Date | null;
  @CrudField({
    label: '发布人',
    edit: 'none',
    nullable: true,
    display: 'users',
  })
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  publishedBy!: string | null;
}
