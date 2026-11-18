// 由代码生成器生成（order.test）
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { TestEntity } from '../../entity/test.entity.js';

@CrudController({
  prefix: 'order/test',
  label: '订单测试',
  entity: TestEntity,
  api: ['page', 'info', 'add', 'update', 'delete', 'export'],
  delete: 'hard',
  pageQuery: {
    keyWords: ['orderNo'],
    fieldEq: ['unitPrice', 'qty', 'state'],
  },
})
export class TestController extends BaseController<TestEntity> {}
