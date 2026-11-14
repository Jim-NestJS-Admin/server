import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../core/crud/base.entity.js';

@Entity('wf_timer')
@Index('uk_wf_timer_task', ['tenantId', 'taskId', 'activeGuard'], {
  unique: true,
})
@Index('idx_wf_timer_due', ['tenantId', 'status', 'dueAt'])
export class WorkflowTimer extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true }) instanceId!: string;
  @Column({ type: 'bigint', unsigned: true }) taskId!: string;
  @Column({ type: 'datetime', precision: 3 }) dueAt!: Date;
  @Column({ type: 'varchar', length: 16 }) action!: 'remind' | 'supervisor';
  @Column({ type: 'varchar', length: 16, default: 'pending' }) status!:
    'pending' | 'claimed' | 'done' | 'cancelled';
  @Column({ type: 'char', length: 36, nullable: true }) claimToken!:
    string | null;
  @Column({ type: 'datetime', precision: 3, nullable: true })
  claimedUntil!: Date | null;
  @Column({ type: 'int', unsigned: true, default: 0 }) attempts!: number;
  @Column({ type: 'varchar', length: 200, nullable: true }) lastError!:
    string | null;
}
