// 由代码生成器生成（order.test）。只生成，不会自动执行：确认后用迁移命令执行
import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';
export class CreateOrderTest1814906215522 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.createTable(
      new Table({
        name: 'order_test',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            unsigned: true,
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'tenant_id',
            type: 'bigint',
            unsigned: true,
            default: "'1'",
          },
          {
            name: 'org_id',
            type: 'bigint',
            unsigned: true,
            isNullable: true,
          },
          {
            name: 'created_by',
            type: 'bigint',
            unsigned: true,
            isNullable: true,
          },
          {
            name: 'updated_by',
            type: 'bigint',
            unsigned: true,
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'datetime',
            precision: 3,
            default: 'CURRENT_TIMESTAMP(3)',
          },
          {
            name: 'updated_at',
            type: 'datetime',
            precision: 3,
            default: 'CURRENT_TIMESTAMP(3)',
            onUpdate: 'CURRENT_TIMESTAMP(3)',
          },
          {
            name: 'version',
            type: 'int',
            unsigned: true,
            default: '1',
          },
          {
            name: 'deleted_at',
            type: 'datetime',
            precision: 3,
            isNullable: true,
          },
          {
            name: 'active_guard',
            type: 'tinyint',
            isNullable: true,
            asExpression: 'IF(`deleted_at` IS NULL, 1, NULL)',
            generatedType: 'STORED',
          },
          {
            name: 'delete_batch',
            type: 'char',
            length: '36',
            isNullable: true,
          },
          {
            name: 'order_no',
            type: 'varchar',
            length: '64',
            isNullable: false,
            comment: '订单编码',
          },
          {
            name: 'unit_price',
            type: 'decimal',
            precision: 14,
            scale: 2,
            isNullable: true,
            comment: '单价',
          },
          {
            name: 'qty',
            type: 'int',
            isNullable: true,
            comment: '数量',
          },
          {
            name: 'state',
            type: 'varchar',
            length: '255',
            isNullable: true,
            comment: '当前状态',
          },
        ],
        indices: [
          {
            columnNames: ['tenant_id'],
          },
          {
            columnNames: ['org_id'],
          },
          {
            name: 'uk_order_test_order_no',
            columnNames: ['tenant_id', 'order_no', 'active_guard'],
            isUnique: true,
          },
        ],
      }),
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.dropTable('order_test');
  }
}
