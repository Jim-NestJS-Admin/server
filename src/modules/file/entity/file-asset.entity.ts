import { ApiHideProperty } from '@nestjs/swagger';
import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, CrudField } from '../../../core/crud/index.js';

/** 文件元数据：对象名和完整性摘要只供模块内部读取，不进入列表或详情响应。 */
@Entity('file_asset')
@Index('idx_file_asset_tenant_created', ['tenantId', 'createdAt'])
export class FileAssetEntity extends BaseEntity {
  @CrudField({ label: '文件名', edit: 'none', form: false })
  @Column({ type: 'varchar', length: 80 })
  name: string;

  @CrudField({ label: '类型', edit: 'none', form: false })
  @Column({ type: 'varchar', length: 64 })
  mime: string;

  @CrudField({
    label: '大小（字节）',
    edit: 'none',
    form: false,
    list: { sortable: true },
  })
  @Column({ type: 'int', unsigned: true })
  bytes: number;

  @ApiHideProperty()
  @Column({ type: 'varchar', length: 160, select: false })
  objectKey: string;

  @ApiHideProperty()
  @Column({ type: 'char', length: 64, select: false })
  sha256: string;
}
