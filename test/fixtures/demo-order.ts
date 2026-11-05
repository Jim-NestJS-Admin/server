import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Injectable } from '@nestjs/common';
import { Column, Entity, Index } from 'typeorm';
import {
  BaseController,
  BaseEntity,
  BaseService,
  CrudController,
  CrudField,
} from '../../src/core/crud/index.js';

/** 主子表演示：订单 + 明细 + 备注，只在测试里注册 */
@Entity('demo_order')
@Index('uk_demo_order_no', ['tenantId', 'orderNo'], { unique: true })
export class DemoOrderEntity extends BaseEntity {
  @CrudField({
    label: '单号',
    list: { sortable: true },
    form: { required: true },
    edit: 'add',
  })
  @IsString()
  @Length(1, 32)
  @Column({ type: 'varchar', length: 32 })
  orderNo: string;

  @CrudField({ label: '标题', form: { required: true } })
  @IsString()
  @Length(1, 64)
  @Column({ type: 'varchar', length: 64 })
  title: string;
}

@Entity('demo_order_item')
export class DemoOrderItemEntity extends BaseEntity {
  @Index()
  @Column({ type: 'bigint', unsigned: true })
  orderId: string;

  @CrudField({ label: '商品', form: { required: true } })
  @IsString()
  @Length(1, 32)
  @Column({ type: 'varchar', length: 32 })
  productCode: string;

  @CrudField({ label: '数量', form: { component: 'number', required: true } })
  @IsInt()
  @Min(1)
  @Max(9999)
  @Column({ type: 'int' })
  qty: number;

  @CrudField({ label: '排序', form: { component: 'number' } })
  @IsOptional()
  @IsInt()
  @Column({ type: 'int', default: 0 })
  sort: number;

  @CrudField({ label: '备注', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Column({ type: 'varchar', length: 100, nullable: true })
  remark: string | null;
}

@Entity('demo_order_note')
export class DemoOrderNoteEntity extends BaseEntity {
  @Index()
  @Column({ type: 'bigint', unsigned: true })
  orderId: string;

  @CrudField({ label: '内容', form: { required: true } })
  @IsString()
  @Length(1, 100)
  @Column({ type: 'varchar', length: 100 })
  content: string;
}

/** 唯一字段带默认值的子表：level 是常量默认值，code 是 SQL 表达式默认值（写入前算不出来） */
@Entity('demo_order_tag')
export class DemoOrderTagEntity extends BaseEntity {
  @Index()
  @Column({ type: 'bigint', unsigned: true })
  orderId: string;

  @CrudField({ label: '名称', form: { required: true } })
  @IsString()
  @Length(1, 20)
  @Column({ type: 'varchar', length: 20 })
  label: string;

  @CrudField({ label: '级别' })
  @IsOptional()
  @IsInt()
  @Column({ type: 'int', default: 0 })
  level: number;

  @CrudField({ label: '代码' })
  @IsOptional()
  @IsString()
  @Length(1, 20)
  @Column({ type: 'varchar', length: 20, default: () => "'none'" })
  code: string;
}

@CrudController({
  prefix: 'test/demo-order',
  label: '演示订单',
  entity: DemoOrderEntity,
  api: ['page', 'info', 'add', 'update', 'delete'],
  children: [
    {
      resource: 'items',
      label: '订单明细',
      entity: DemoOrderItemEntity,
      foreignKey: 'orderId',
      min: 1,
      max: 5,
      unique: [['productCode']],
      sortField: 'sort',
    },
    {
      resource: 'notes',
      label: '订单备注',
      entity: DemoOrderNoteEntity,
      foreignKey: 'orderId',
    },
    {
      resource: 'tags',
      label: '订单标签',
      entity: DemoOrderTagEntity,
      foreignKey: 'orderId',
      unique: [['level'], ['code', 'label']],
    },
  ],
})
export class DemoOrderController extends BaseController<DemoOrderEntity> {}

/** 明细自己开放写接口：启动时必须报错（子表只有主表一个写入口） */
@CrudController({
  prefix: 'test/demo-order-item',
  label: '明细直写',
  entity: DemoOrderItemEntity,
  api: ['page', 'update'],
})
export class DemoOrderItemWriteController extends BaseController<DemoOrderItemEntity> {}

/** 明细的只读资源：允许注册，但它的 Service 不能新增、修改、删除 */
@Injectable()
export class DemoOrderItemReadService extends BaseService<DemoOrderItemEntity> {}

@CrudController({
  prefix: 'test/demo-order-item-read',
  label: '明细只读',
  entity: DemoOrderItemEntity,
  api: ['page', 'info'],
  service: DemoOrderItemReadService,
})
export class DemoOrderItemReadController extends BaseController<DemoOrderItemEntity> {}
