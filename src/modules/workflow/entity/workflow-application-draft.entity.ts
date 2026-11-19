import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../core/crud/index.js';

@Entity('wf_application_draft')
@Index('idx_wf_application_draft_owner', [
  'tenantId',
  'createdBy',
  'orgId',
  'instanceId',
])
export class WorkflowApplicationDraft extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true }) definitionId!: string;
  @Column({ length: 100 }) name!: string;
  @Column({ type: 'json' }) values!: Record<string, unknown>;
  @Column({ type: 'json' }) selections!: Record<string, string[]>;
  @Column({ type: 'bigint', unsigned: true, nullable: true }) instanceId!:
    string | null;
}
