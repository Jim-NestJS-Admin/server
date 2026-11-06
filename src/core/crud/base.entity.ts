import { DEFAULT_TENANT_ID } from '../tenant/tenant.constants.js';
import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

export { DEFAULT_TENANT_ID };

/**
 * 所有业务表的基类（架构「核心框架层 · 实体基类」）。
 * bigint 字段在 JS 里一律是字符串，前端也按字符串处理，避免超过安全整数丢精度。
 * 这些字段都由框架维护，新增和修改接口不接受前端传入。
 */
export abstract class BaseEntity {
  @ApiProperty({ description: '编号', type: String, example: '1' })
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @ApiHideProperty()
  @Index()
  @Column({ type: 'bigint', unsigned: true, default: DEFAULT_TENANT_ID })
  tenantId: string;

  @ApiProperty({ description: '创建人', type: String, nullable: true })
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  createdBy: string | null;

  @ApiProperty({ description: '修改人', type: String, nullable: true })
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  updatedBy: string | null;

  @ApiProperty({ description: '创建时间', type: String, format: 'date-time' })
  @CreateDateColumn({
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt: Date;

  @ApiProperty({ description: '修改时间', type: String, format: 'date-time' })
  @UpdateDateColumn({
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt: Date;

  /** 乐观锁版本号：修改时带上读到的值，每次修改加 1 */
  @ApiProperty({ description: '版本号，修改时原样带回', type: Number })
  @VersionColumn({ type: 'int', unsigned: true })
  version: number;

  @ApiHideProperty()
  @DeleteDateColumn({ type: 'datetime', precision: 3, nullable: true })
  deletedAt: Date | null;

  /**
   * 软删除下的唯一约束用（架构「删除方式 · 唯一字段的处理」）：数据库生成列，未删除时为 1、已删除时为空。
   * 业务唯一索引建在「租户 + 业务字段 + activeGuard」上：有效记录必须唯一，删掉的可以有多条同名。
   */
  @ApiHideProperty()
  @Column({
    type: 'tinyint',
    nullable: true,
    generatedType: 'STORED',
    asExpression: 'IF(`deleted_at` IS NULL, 1, NULL)',
    insert: false,
    update: false,
    select: false,
  })
  activeGuard: number | null;

  /** 删除批次：同一次删除的主表和随它一起删的子行是同一个批次，恢复主表时只恢复这一批子行 */
  @ApiHideProperty()
  @Column({ type: 'char', length: 36, nullable: true, select: false })
  deleteBatch: string | null;
}

/** 由框架维护、任何时候都不允许前端写入的字段 */
export const SYSTEM_FIELDS = [
  'id',
  'tenantId',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
  'version',
  'deletedAt',
  'activeGuard',
  'deleteBatch',
] as const;

/** 不在接口响应里出现的内部字段 */
export const INTERNAL_FIELDS = [
  'tenantId',
  'deletedAt',
  'activeGuard',
  'deleteBatch',
] as const;
