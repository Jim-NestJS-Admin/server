import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
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

export class WorkflowActor {
  @ApiProperty({
    enum: [
      'users',
      'roles',
      'department_leader',
      'supervisor',
      'self_select',
      'applicant',
    ],
  })
  type!:
    | 'users'
    | 'roles'
    | 'department_leader'
    | 'supervisor'
    | 'self_select'
    | 'applicant';
  @ApiPropertyOptional({ type: [String] }) ids?: string[];
  @ApiPropertyOptional({ minimum: 1, maximum: 10 })
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
export class WorkflowConditionValue {
  @ApiProperty({ enum: ['field', 'applicant_org', 'applicant_role'] }) source!:
    'field' | 'applicant_org' | 'applicant_role';
  @ApiPropertyOptional() field?: string;
  @ApiProperty({ enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in'] })
  operator!: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in';
  @ApiProperty({
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      {
        type: 'array',
        items: {
          oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
        },
      },
    ],
  })
  value!: string | number | boolean | (string | number | boolean)[];
}
const conditionSchema = () => [
  { $ref: getSchemaPath('WorkflowConditionValue') },
  { $ref: getSchemaPath('WorkflowConditionGroup') },
];
export class WorkflowConditionGroup {
  @ApiProperty({ enum: ['all', 'any'] }) logic!: 'all' | 'any';
  @ApiProperty({ type: 'array', items: { oneOf: conditionSchema() } })
  conditions!: WorkflowCondition[];
}
export class WorkflowBranch {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ oneOf: conditionSchema() })
  condition?: WorkflowCondition;
  @ApiPropertyOptional() default?: boolean;
  @ApiProperty({ type: () => [WorkflowNode] }) nodes!: WorkflowNode[];
}
export class WorkflowTimeout {
  @ApiProperty() minutes!: number;
  @ApiProperty({ enum: ['remind', 'supervisor'] }) action!:
    'remind' | 'supervisor';
}
export class WorkflowNode {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['approve', 'copy', 'condition', 'parallel'] }) type!:
    'approve' | 'copy' | 'condition' | 'parallel';
  @ApiPropertyOptional({ type: WorkflowActor }) actor?: WorkflowActor;
  @ApiPropertyOptional({ enum: ['sequential', 'all', 'any'] }) mode?:
    'sequential' | 'all' | 'any';
  @ApiPropertyOptional({ enum: ['pass', 'administrator', 'stop'] }) empty?:
    'pass' | 'administrator' | 'stop';
  @ApiPropertyOptional() skipRepeated?: boolean;
  @ApiPropertyOptional({ enum: ['applicant'] }) rejectTo?: 'applicant';
  @ApiPropertyOptional({ type: () => WorkflowTimeout })
  timeout?: WorkflowTimeout;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: {
      type: 'string',
      enum: ['editable', 'readonly', 'masked', 'hidden'],
    },
  })
  fieldPermissions?: Record<
    string,
    'editable' | 'readonly' | 'masked' | 'hidden'
  >;
  @ApiPropertyOptional({ type: () => [WorkflowBranch] })
  branches?: WorkflowBranch[];
}
@ApiExtraModels(
  WorkflowActor,
  WorkflowNode,
  WorkflowBranch,
  WorkflowConditionGroup,
  WorkflowConditionValue,
  WorkflowTimeout,
)
export class WorkflowDesignerDto {
  @ApiProperty({ enum: [1] }) schemaVersion!: 1;
  @ApiProperty({
    type: () => [WorkflowNode],
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
