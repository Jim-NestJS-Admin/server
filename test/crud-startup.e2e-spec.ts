import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
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
