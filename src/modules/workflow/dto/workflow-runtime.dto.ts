import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  IsObject,
  IsArray,
  ArrayMaxSize,
  ArrayUnique,
  Max,
} from 'class-validator';
import { ID_PATTERN } from '../../../core/crud/crud.dto.js';
import { WorkflowInstance } from '../entity/workflow-runtime.entity.js';
import { FormFieldDto } from '../../form/dto/form.dto.js';

export class StartWorkflowBody {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
    description: '自选节点标识到成员编号数组',
  })
  @IsOptional()
  @IsObject()
  selections?: Record<string, string[]>;
  @ApiProperty({ description: '已发布的固定流程版本编号' })
  @Matches(ID_PATTERN)
  definitionId!: string;
  @ApiProperty({
    description: '本人已保存的正式表单提交记录，不重复创建填写数据',
  })
  @Matches(ID_PATTERN)
  submissionId!: string;
}
export class ApplicationInput {
  @ApiProperty() @Matches(ID_PATTERN) definitionId!: string;
  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  values!: Record<string, unknown>;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
  })
  @IsOptional()
  @IsObject()
  selections?: Record<string, string[]>;
  @ApiPropertyOptional() @IsOptional() @Matches(ID_PATTERN) draftId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) version?: number;
}
export class ApplicationDraftRow {
  @ApiProperty() id!: string;
  @ApiProperty() version!: number;
  @ApiProperty() definitionId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) values!: Record<
    string,
    unknown
  >;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
  })
  selections!: Record<string, string[]>;
}
export class ApplicationDraftPageBody {
  @ApiPropertyOptional({ default: 1 })
  @IsInt()
  @Min(1)
  @Max(10000)
  page: number = 1;
}
export class ApplicationDraftChoice {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() updatedAt!: Date;
}
export class ApplicationDraftPage {
  @ApiProperty({ type: [ApplicationDraftChoice] })
  list!: ApplicationDraftChoice[];
  @ApiProperty() total!: number;
}
export class ApproveWorkflowBody {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: '仅当前节点可编辑的表单字段',
  })
  @IsOptional()
  @IsObject()
  values?: Record<string, unknown>;
  @ApiPropertyOptional({ type: [String], maxItems: 10 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @Matches(ID_PATTERN, { each: true })
  attachmentIds?: string[];
  @ApiProperty() @Matches(ID_PATTERN) id!: string;
  @ApiProperty({ description: '待办的乐观锁版本号' })
  @IsInt()
  @Min(1)
  version!: number;
  @ApiPropertyOptional({ maxLength: 1000, description: '审批意见（纯文本）' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
export class TransferWorkflowBody extends ApproveWorkflowBody {
  @ApiProperty() @Matches(ID_PATTERN) targetUserId!: string;
}
export class WorkflowInstanceActionBody {
  @ApiProperty() @Matches(ID_PATTERN) id!: string;
  @ApiProperty() @IsInt() @Min(1) version!: number;
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
export class ResubmitWorkflowBody extends WorkflowInstanceActionBody {
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  values?: Record<string, unknown>;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
  })
  @IsOptional()
  @IsObject()
  selections?: Record<string, string[]>;
}
export class WorkflowDocumentBody {
  @ApiPropertyOptional({
    description: '从本人待办打开时指定，编辑权限只按此待办计算；不传则只读查看',
  })
  @IsOptional()
  @Matches(ID_PATTERN)
  taskId?: string;
  @ApiProperty() @Matches(ID_PATTERN) id!: string;
}
export class WorkflowAttachmentBody extends WorkflowDocumentBody {
  @ApiProperty() @Matches(ID_PATTERN) recordId!: string;
  @ApiProperty() @Matches(ID_PATTERN) fileId!: string;
}
export class WorkflowPreviewBody extends WorkflowDocumentBody {
  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  values!: Record<string, unknown>;
}
export class WorkflowFormView {
  @ApiProperty() id!: string;
  @ApiProperty() definitionId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() code!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ type: [FormFieldDto] }) fields!: FormFieldDto[];
  @ApiProperty({ type: 'object', additionalProperties: true }) values!: Record<
    string,
    unknown
  >;
  @ApiProperty({
    type: 'object',
    additionalProperties: {
      type: 'string',
      enum: ['editable', 'readonly', 'masked', 'hidden'],
    },
  })
  fieldStates!: Record<string, string>;
}
export class WorkflowProgressBranch {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: () => [WorkflowProgressNode] })
  nodes!: WorkflowProgressNode[];
}
export class WorkflowGraphMember {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() avatar?: string;
}
export class WorkflowProgressNode {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['approve', 'copy', 'condition', 'parallel'] })
  type!: 'approve' | 'copy' | 'condition' | 'parallel';
  @ApiProperty({
    enum: [
      'waiting',
      'pending',
      'approved',
      'cancelled',
      'returned',
      'copied',
      'taken',
    ],
  })
  status!:
    | 'waiting'
    | 'pending'
    | 'approved'
    | 'cancelled'
    | 'returned'
    | 'copied'
    | 'taken';
  @ApiPropertyOptional({
    enum: [
      'users',
      'roles',
      'department_leader',
      'supervisor',
      'self_select',
      'applicant',
    ],
  })
  actorType?: string;
  @ApiPropertyOptional() actorLevel?: number;
  @ApiPropertyOptional({ enum: ['all', 'any', 'sequential'] }) mode?: string;
  @ApiPropertyOptional({ type: [WorkflowGraphMember] })
  members?: WorkflowGraphMember[];
  @ApiPropertyOptional() chosenBranch?: string;
  @ApiPropertyOptional({ type: () => [WorkflowProgressBranch] })
  branches?: WorkflowProgressBranch[];
}
export class WorkflowDocumentResult {
  @ApiProperty({ type: WorkflowInstance }) instance!: WorkflowInstance;
  @ApiProperty({ type: WorkflowFormView }) form!: WorkflowFormView;
  @ApiProperty({ type: [WorkflowProgressNode] })
  progress!: WorkflowProgressNode[];
}
