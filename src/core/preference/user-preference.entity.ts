import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../crud/base.entity.js';

/**
 * 用户偏好（T18 常用查询、T23 / T24 列设置等）：按租户 + 用户 + 当前组织隔离。
 * scope 是存的时候的当前组织编号（没有组织时是 -），唯一约束带它，避免可空列在唯一索引里重复。
 */
@Entity('sys_user_pref')
@Index(
  'uk_sys_user_pref',
  ['tenantId', 'userId', 'scope', 'key', 'activeGuard'],
  {
    unique: true,
  },
)
export class UserPreferenceEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  userId: string;

  @Column({ type: 'varchar', length: 32 })
  scope: string;

  /** 例如 query:system:user（常用查询）、columns:system:user（列设置） */
  @Column({ type: 'varchar', length: 100 })
  key: string;

  @Column({ type: 'json' })
  value: unknown;
}
