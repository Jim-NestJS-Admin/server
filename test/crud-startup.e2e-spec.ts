import { IsString } from 'class-validator';
import { Column, Entity, Index } from 'typeorm';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  BaseController,
  BaseEntity,
  CrudController,
  CrudField,
} from '../src/core/crud/index.js';
import {
  DemoOrderController,
  DemoOrderEntity,
  DemoOrderItemEntity,
  DemoOrderNoteEntity,
} from './fixtures/demo-order.js';

// 单独一个文件：@nestjs/typeorm 的 autoLoadEntities 在同一进程里会累积之前测试模块注册过的实体，
// 和别的用例放在一起时「没注册」的实体会被之前的模块带进来
describe('启动检查', () => {
  it('子表实体没在 TypeORM 注册：启动时就报错，而不是请求时 500', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule,
        TypeOrmModule.forFeature([
          DemoOrderEntity,
          DemoOrderItemEntity,
          DemoOrderNoteEntity,
        ]),
      ],
      controllers: [DemoOrderController],
    }).compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await expect(app.init()).rejects.toThrow(
      /实体 DemoOrderTagEntity 没有注册/,
    );
    await app.close().catch(() => undefined);
  });
});

/** 软删除的表，唯一约束却没带 activeGuard：删掉的记录会一直占着业务键 */
@Entity('demo_bad_unique')
@Index('uk_demo_bad_code', ['tenantId', 'code'], { unique: true })
class BadUniqueEntity extends BaseEntity {
  @CrudField({ label: '编码' })
  @IsString()
  @Column({ type: 'varchar', length: 20 })
  code: string;
}

@CrudController({
  prefix: 'test/bad-unique',
  label: '坏唯一',
  entity: BadUniqueEntity,
  api: ['page'],
})
class BadUniqueController extends BaseController<BadUniqueEntity> {}

describe('启动检查：唯一约束', () => {
  it('软删除资源的唯一约束缺 activeGuard：启动时报错并说明要怎么建', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, TypeOrmModule.forFeature([BadUniqueEntity])],
      controllers: [BadUniqueController],
    }).compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await expect(app.init()).rejects.toThrow(
      /唯一约束 uk_demo_bad_code（tenantId, code）缺少 activeGuard/,
    );
    await app.close().catch(() => undefined);
  });
});
