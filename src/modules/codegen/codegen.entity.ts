import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../core/crud/base.entity.js';

/** 代码生成配置：一个模块（module.business）一行；fingerprints 记上次写入时每个文件的内容指纹 */
@Entity('sys_codegen')
@Index('uk_sys_codegen', ['tenantId', 'name', 'activeGuard'], { unique: true })
export class CodegenEntity extends BaseEntity {
  /** module.business */
  @Column({ type: 'varchar', length: 130 })
  name: string;

  @Column({ type: 'varchar', length: 30 })
  label: string;

  @Column({ type: 'json' })
  config: unknown;

  @Column({ type: 'json', nullable: true })
  fingerprints: Record<string, string> | null;
}
