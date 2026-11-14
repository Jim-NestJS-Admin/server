import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ID_PATTERN } from '../../../core/crud/crud.dto.js';

export interface WorkflowActor {
  type:
    | 'users'
    | 'roles'
    | 'department_leader'
    | 'supervisor'
    | 'self_select'
    | 'applicant';
  ids?: string[];
  level?: number;
}
export type WorkflowCondition =
  | { logic: 'all' | 'any'; conditions: WorkflowCondition[] }
  | {
      source: 'field' | 'applicant_org' | 'applicant_role';
      field?: string;
      operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in';
      value: string | number | boolean | (string | number | boolean)[];
    };
export interface WorkflowBranch {
  id: string;
  name: string;
  condition?: WorkflowCondition;
  default?: boolean;
  nodes: WorkflowNode[];
}
export interface WorkflowNode {
  id: string;
  name: string;
  type: 'approve' | 'copy' | 'condition' | 'parallel';
  actor?: WorkflowActor;
  mode?: 'sequential' | 'all' | 'any';
  empty?: 'pass' | 'administrator' | 'stop';
  skipRepeated?: boolean;
  rejectTo?: 'applicant';
  timeout?: { minutes: number; action: 'remind' | 'supervisor' };
  fieldPermissions?: Record<
    string,
    'editable' | 'readonly' | 'masked' | 'hidden'
  >;
  branches?: WorkflowBranch[];
}
export class WorkflowDesignerDto {
  @ApiProperty({ enum: [1] }) schemaVersion!: 1;
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      '安全流程节点树，结构见docs/contracts/workflow.md；不接收BPMN或脚本',
  })
  nodes!: WorkflowNode[];
}
export class WorkflowDefinitionInput {
  @ApiProperty() @IsString() @MaxLength(100) @Matches(/\S/) name!: string;
  @ApiPropertyOptional({ default: '' })
  @IsString()
  @MaxLength(500)
  description: string = '';
  @ApiProperty() @Matches(ID_PATTERN) formDefinitionId!: string;
  @ApiProperty({ type: WorkflowDesignerDto })
  @IsObject()
  designer!: WorkflowDesignerDto;
}
export class CreateWorkflowBody {
  @ApiProperty({ type: WorkflowDefinitionInput })
  @ValidateNested()
  @Type(() => WorkflowDefinitionInput)
  data!: WorkflowDefinitionInput;
}
export class ReviseWorkflowBody extends CreateWorkflowBody {
  @ApiProperty() @Matches(ID_PATTERN) definitionId!: string;
  @ApiProperty() @IsInt() @Min(1) baseRevision!: number;
}
export class PublishWorkflowBody {
  @ApiProperty() @Matches(ID_PATTERN) id!: string;
  @ApiProperty() @IsInt() @Min(1) version!: number;
}
export class InspectWorkflowBody {
  @ApiProperty() @Matches(ID_PATTERN) formDefinitionId!: string;
  @ApiProperty({ type: WorkflowDesignerDto })
  @IsObject()
  designer!: WorkflowDesignerDto;
}
export class WorkflowInspection {
  @ApiProperty({ type: WorkflowDesignerDto }) designer!: WorkflowDesignerDto;
  @ApiProperty() nodeCount!: number;
  @ApiProperty({ description: '仅由服务端生成的BPMN模板，执行需T38运行时服务' })
  bpmn!: string;
  @ApiProperty() digest!: string;
}
