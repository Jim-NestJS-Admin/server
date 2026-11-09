import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../crud/base.entity.js';

/** 管理员的模块显示配置（契约 page-config.md）：一个资源一行，version 是乐观锁 */
@Entity('sys_page_config')
@Index('uk_sys_page_config', ['tenantId', 'resource', 'activeGuard'], {
  unique: true,
})
export class PageConfigEntity extends BaseEntity {
  /** 资源的权限码前缀，如 system:user */
  @Column({ type: 'varchar', length: 100 })
  resource: string;

  @Column({ type: 'json' })
  config: unknown;
}

/** 修改历史：每次保存、恢复、重置前把当时的配置存一份（null 表示当时是代码默认） */
@Entity('sys_page_config_history')
@Index('idx_sys_page_config_history', ['tenantId', 'resource', 'createdAt'])
export class PageConfigHistoryEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 100 })
  resource: string;

  @Column({ type: 'json', nullable: true })
  config: unknown;

  /** 这份配置当时的版本号 */
  @Column({ type: 'int', unsigned: true })
  configVersion: number;
}
