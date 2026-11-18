// 由代码生成器生成（order.test）。在 AppModule 的 imports 里加上 TestModule
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TestController } from './controller/admin/test.controller.js';
import { TestEntity } from './entity/test.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([TestEntity])],
  controllers: [TestController],
})
export class TestModule {}
