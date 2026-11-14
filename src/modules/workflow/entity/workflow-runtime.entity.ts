import { Column, Entity, Index } from 'typeorm';
import { ApiHideProperty } from '@nestjs/swagger';
import type { BpmnEngineExecutionState } from 'bpmn-engine';
import { BaseEntity, CrudField } from '../../../core/crud/index.js';
import { FieldPerm } from '../../../core/field-perm/field-perm.decorator.js';
import type { WorkflowDesignerDto } from '../dto/workflow.dto.js';

@Entity('wf_instance')
@Index(
  'uk_wf_instance_submission',
  ['tenantId', 'submissionId', 'activeGuard'],
  { unique: true },
)
export class WorkflowInstance extends BaseEntity {
  @CrudField({ label: '流程定义', edit: 'none' })
  @Column({ type: 'bigint', unsigned: true })
  definitionId!: string;
  @CrudField({ label: '表单提交记录', edit: 'none' })
  @Column({ type: 'bigint', unsigned: true })
  submissionId!: string;
  @CrudField({ label: '固定表单版本', edit: 'none' })
  @Column({ type: 'bigint', unsigned: true })
  formDefinitionId!: string;
  @CrudField({ label: '流程编码', edit: 'none' })
  @Column({ type: 'varchar', length: 64 })
  code!: string;
  @CrudField({ label: '流程名称', edit: 'none' })
  @Column({ type: 'varchar', length: 100 })
  name!: string;
  @CrudField({ label: '流程版本', edit: 'none' })
  @Column({ type: 'int', unsigned: true })
  revision!: number;
  @CrudField({ label: '申请人', edit: 'none', display: 'users' })
  @Column({ type: 'bigint', unsigned: true })
  applicantId!: string;
  @CrudField({
    label: '状态',
    edit: 'none',
    dict: [
      { value: 'running', label: '审批中', tagType: 'primary' },
      { value: 'approved', label: '已通过', tagType: 'success' },
    ],
  })
  @Column({ type: 'varchar', length: 16 })
  status!: 'running' | 'approved';
  @CrudField({ label: '结束时间', edit: 'none', nullable: true })
  @Column({ type: 'datetime', precision: 3, nullable: true })
  endedAt!: Date | null;

  // 内部运行信息不声明CrudField，不进入列表、详情或导出响应。
  @ApiHideProperty()
  @Column({ type: 'json' })
  designer!: WorkflowDesignerDto;
  @ApiHideProperty()
  @Column({ type: 'longtext' })
  bpmn!: string;
  @ApiHideProperty()
  @Column({ type: 'char', length: 64 })
  digest!: string;
  @Column({ type: 'int', unsigned: true }) compilerVersion!: number;
  @ApiHideProperty()
  @Column({ type: 'json' })
  actors!: Record<string, string[]>;
  @ApiHideProperty()
  @Column({ type: 'json' })
  engineState!: BpmnEngineExecutionState;
}

@Entity('wf_task')
@Index(
  'uk_wf_task_execution',
  ['tenantId', 'instanceId', 'executionId', 'activeGuard'],
  { unique: true },
)
@Index('idx_wf_task_inbox', ['tenantId', 'assigneeId', 'status'])
export class WorkflowTask extends BaseEntity {
  @CrudField({ label: '审批实例', edit: 'none' })
  @Column({ type: 'bigint', unsigned: true })
  instanceId!: string;
  @CrudField({ label: '节点标识', edit: 'none' })
  @Column({ type: 'varchar', length: 48 })
  nodeId!: string;
  @CrudField({ label: '节点名称', edit: 'none' })
  @Column({ type: 'varchar', length: 100 })
  name!: string;
  @CrudField({ label: '办理人', edit: 'none', display: 'users' })
  @Column({ type: 'bigint', unsigned: true })
  assigneeId!: string;
  @CrudField({
    label: '状态',
    edit: 'none',
    dict: [
      { value: 'pending', label: '待处理', tagType: 'warning' },
      { value: 'approved', label: '已同意', tagType: 'success' },
      { value: 'cancelled', label: '已取消', tagType: 'info' },
    ],
  })
  @Column({ type: 'varchar', length: 16 })
  status!: 'pending' | 'approved' | 'cancelled';
  @CrudField({ label: '办理时间', edit: 'none', nullable: true })
  @Column({ type: 'datetime', precision: 3, nullable: true })
  completedAt!: Date | null;
  @Column({ type: 'varchar', length: 200 }) executionId!: string;
  @Column({ type: 'int', unsigned: true }) actorIndex!: number;
}

@Entity('wf_record')
@Index('idx_wf_record_instance', ['tenantId', 'instanceId', 'id'])
export class WorkflowRecord extends BaseEntity {
  @CrudField({ label: '审批实例', edit: 'none' })
  @Column({ type: 'bigint', unsigned: true })
  instanceId!: string;
  @CrudField({ label: '待办', edit: 'none', nullable: true })
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  taskId!: string | null;
  @CrudField({
    label: '动作',
    edit: 'none',
    dict: [
      { value: 'start', label: '发起申请' },
      { value: 'approve', label: '同意' },
      { value: 'empty_pass', label: '无办理人自动通过' },
    ],
  })
  @Column({ type: 'varchar', length: 16 })
  action!: 'start' | 'approve' | 'empty_pass';
  @CrudField({ label: '节点', edit: 'none', nullable: true })
  @Column({ type: 'varchar', length: 48, nullable: true })
  nodeId!: string | null;
  @CrudField({
    label: '操作人',
    edit: 'none',
    nullable: true,
    display: 'users',
  })
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  actorId!: string | null;
  @CrudField({ label: '意见', edit: 'none' })
  @FieldPerm({ label: '审批意见', default: 'readonly' })
  @Column({ type: 'varchar', length: 1000, default: '' })
  comment!: string;
}

/** 仅存事件路由编号，不保存填写内容/意见；T39投递时重新按接收人权限读取。 */
@Entity('wf_outbox')
@Index('uk_wf_outbox_event', ['tenantId', 'eventKey', 'activeGuard'], {
  unique: true,
})
@Index('idx_wf_outbox_pending', ['tenantId', 'status', 'createdAt'])
export class WorkflowOutbox extends BaseEntity {
  @Column({ type: 'varchar', length: 120 }) eventKey!: string;
  @Column({ type: 'varchar', length: 32 }) event!:
    'task.created' | 'task.cancelled' | 'instance.approved';
  @Column({ type: 'bigint', unsigned: true }) instanceId!: string;
  @Column({ type: 'bigint', unsigned: true, nullable: true }) taskId!:
    string | null;
  @Column({ type: 'bigint', unsigned: true, nullable: true }) recipientId!:
    string | null;
  @Column({ type: 'varchar', length: 16, default: 'pending' }) status!:
    'pending' | 'sent';
}

export const WORKFLOW_RUNTIME_ENTITIES = [
  WorkflowInstance,
  WorkflowTask,
  WorkflowRecord,
  WorkflowOutbox,
];
