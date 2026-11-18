import { Column, Entity, Index } from 'typeorm';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import { BaseEntity } from '../../../core/crud/base.entity.js';
import { CrudField } from '../../../core/crud/crud-field.decorator.js';

@Entity('ai_setting')
@Index('uk_ai_setting_code', ['tenantId', 'code', 'activeGuard'], {
  unique: true,
})
export class AiSetting extends BaseEntity {
  @Column({ type: 'varchar', length: 16, default: 'default' }) code!: string;
  @CrudField({ label: '启用', edit: 'none' })
  @Column({ type: 'boolean', default: false })
  enabled!: boolean;
  @CrudField({ label: '模型', edit: 'none' })
  @Column({ type: 'varchar', length: 150 })
  model!: string;
  @CrudField({ label: '最大输出Token', edit: 'none' })
  @Column({ type: 'int', unsigned: true })
  maxOutputTokens!: number;
  @Column({ type: 'text', nullable: true, select: false }) keyCipher!:
    string | null;
}

@Entity('ai_template')
@Index(
  'uk_ai_template_revision',
  ['tenantId', 'code', 'revision', 'activeGuard'],
  { unique: true },
)
export class AiTemplate extends BaseEntity {
  @CrudField({ label: '功能', edit: 'none' })
  @IsIn(['generate', 'rewrite', 'translate'])
  @Column({ type: 'varchar', length: 20 })
  code!: string;
  @CrudField({ label: '修订', edit: 'none' })
  @IsInt()
  @Min(1)
  @Column({ type: 'int', unsigned: true })
  revision!: number;
  @CrudField({ label: '提示词', edit: 'none' })
  @Column({ type: 'text' })
  content!: string;
}

export type AiStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain';
@Entity('ai_task')
@Index('idx_ai_task_queue', ['tenantId', 'status', 'createdAt'])
export class AiTask extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true }) ownerId!: string;
  @CrudField({ label: '功能', edit: 'none' })
  @IsIn(['generate', 'rewrite', 'translate'])
  @Column({ type: 'varchar', length: 20 })
  feature!: string;
  @CrudField({ label: '状态', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 16 })
  status!: AiStatus;
  @CrudField({ label: '模型', edit: 'none' })
  @IsString()
  @Column({ type: 'varchar', length: 150 })
  model!: string;
  @CrudField({ label: '模板修订', edit: 'none' })
  @Column({ type: 'int', unsigned: true })
  templateRevision!: number;
  @Column({ type: 'char', length: 7 }) month!: string;
  @CrudField({ label: '预占Token', edit: 'none' })
  @Column({ type: 'bigint', unsigned: true })
  reservedTokens!: string;
  @CrudField({ label: '输入Token', edit: 'none' })
  @Column({ type: 'int', unsigned: true, default: 0 })
  inputTokens!: number;
  @CrudField({ label: '输出Token', edit: 'none' })
  @Column({ type: 'int', unsigned: true, default: 0 })
  outputTokens!: number;
  @CrudField({ label: '耗时毫秒', edit: 'none' })
  @Column({ type: 'int', unsigned: true, default: 0 })
  durationMs!: number;
  @CrudField({ label: '错误说明', edit: 'none' })
  @Column({ type: 'varchar', length: 100, default: '' })
  error!: string;
  @Column({ type: 'int', unsigned: true }) maxOutputTokens!: number;
  @Column({ type: 'text', nullable: true, select: false }) requestCipher!:
    string | null;
  @Column({ type: 'mediumtext', nullable: true, select: false }) resultCipher!:
    string | null;
  @Column({ type: 'datetime', precision: 3, nullable: true })
  leaseUntil!: Date | null;
  @Column({ type: 'char', length: 36, nullable: true }) claimToken!:
    string | null;
}

@Entity('ai_monthly_usage')
@Index('uk_ai_monthly_usage', ['tenantId', 'month', 'activeGuard'], {
  unique: true,
})
export class AiMonthlyUsage extends BaseEntity {
  @Column({ type: 'char', length: 7 }) month!: string;
  @Column({ type: 'bigint', unsigned: true, default: '0' }) usedTokens!: string;
  @Column({ type: 'bigint', unsigned: true, default: '0' })
  reservedTokens!: string;
}

@Entity('ai_reconciliation')
@Index('uk_ai_reconciliation_task', ['tenantId', 'taskId', 'activeGuard'], {
  unique: true,
})
export class AiReconciliation extends BaseEntity {
  @CrudField({ label: '任务编号', edit: 'none' })
  @Matches(/^[1-9]\d{0,19}$/)
  @Column({ type: 'bigint', unsigned: true })
  taskId!: string;
  @CrudField({ label: '确认已计费', edit: 'none' })
  @IsBoolean()
  @Column({ type: 'boolean' })
  charged!: boolean;
  @CrudField({ label: '输入Token', edit: 'none' })
  @Column({ type: 'int', unsigned: true })
  inputTokens!: number;
  @CrudField({ label: '输出Token', edit: 'none' })
  @Column({ type: 'int', unsigned: true })
  outputTokens!: number;
  @CrudField({ label: '核对依据', edit: 'none' })
  @Column({ type: 'varchar', length: 200 })
  evidence!: string;
}
