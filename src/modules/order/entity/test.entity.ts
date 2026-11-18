// 由代码生成器生成（order.test），可以继续手改；再次生成时手改过的文件默认不覆盖
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { Column, Entity, Index } from 'typeorm';
import {
  BaseEntity,
  CrudField,
  DecimalInput,
} from '../../../core/crud/index.js';

@Entity('order_test')
@Index('uk_order_test_order_no', ['tenantId', 'orderNo', 'activeGuard'], {
  unique: true,
})
export class TestEntity extends BaseEntity {
  @CrudField({
    label: '订单编码',
    list: { sortable: true },
    form: { component: 'input', required: true },
    code: { charset: 'unrestricted' },
  })
  @IsString()
  @MaxLength(64)
  @Column({ name: 'order_no', type: 'varchar', length: 64 })
  orderNo: string;

  @CrudField({
    label: '单价',
    list: { sortable: true },
    form: { component: 'number', required: false },
    nullable: true,
  })
  @IsOptional()
  @DecimalInput({ label: '单价', precision: 14, scale: 2 })
  @Column({
    name: 'unit_price',
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
  })
  unitPrice: string | null;

  @CrudField({
    label: '数量',
    list: { sortable: true },
    form: { component: 'number', required: false },
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Column({ name: 'qty', type: 'int', nullable: true })
  qty: number | null;

  @CrudField({
    label: '当前状态',
    list: { sortable: true },
    form: { component: 'select', required: false },
    nullable: true,
    dictCode: 'sys.common_status',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Column({ name: 'state', type: 'varchar', length: 255, nullable: true })
  state: string | null;
}
