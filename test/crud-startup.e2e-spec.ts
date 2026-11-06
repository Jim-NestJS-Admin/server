import { IsString } from 'class-validator';
import { Column, Entity, Index } from 'typeorm';
import { Controller, Get } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  AdminController,
  Anonymous,
  AppController,
  IgnoreTenant,
  Public,
} from '../src/core/endpoint/endpoint.decorators.js';
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
import { createTestModule } from './support/test-auth.js';

// 单独一个文件：@nestjs/typeorm 的 autoLoadEntities 在同一进程里会累积之前测试模块注册过的实体，
// 和别的用例放在一起时「没注册」的实体会被之前的模块带进来
describe('启动检查', () => {
  it('子表实体没在 TypeORM 注册：启动时就报错，而不是请求时 500', async () => {
    const moduleRef = await createTestModule({
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
    const moduleRef = await createTestModule({
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

@Controller('plain')
class PlainController {
  @Get() ok() {
    return 1;
  }
}

@AppController('member')
class MemberController {
  @Get() ok() {
    return 1;
  }
}

@Public()
@Controller('admin/sneaky')
class SneakyPublicController {
  @Get() ok() {
    return 1;
  }
}

@Public()
@Controller('ping')
class PublicIgnoreController {
  @Get()
  @IgnoreTenant()
  ok() {
    return 1;
  }
}

@AdminController('review')
class MethodPublicController {
  @Get('open')
  @Public()
  sneaky() {
    return 1;
  }
}

@Public()
@Controller('')
class RootPublicController {
  @Get('admin/review-public-root')
  sneaky() {
    return 1;
  }
}

class BaseWithPublicRoute {
  @Get('admin/inherited')
  sneaky() {
    return 1;
  }
}

@Public()
@Controller('')
class InheritedPublicController extends BaseWithPublicRoute {}

// Express 路由不区分大小写：/AdMiN/review-case 实际就是 /admin/review-case
@Public()
@Controller('AdMiN/review-case')
class MixedCasePublicController {
  @Get() ok() {
    return 1;
  }
}

@AdminController('review-anon')
class MethodAnonymousController {
  @Get('open')
  @Anonymous()
  sneaky() {
    return 1;
  }
}

@Anonymous()
@Public()
@Controller('anon-public')
class AnonymousPublicController {
  @Get() ok() {
    return 1;
  }
}

@Anonymous()
@AdminController('anon-cross')
class AnonymousIgnoreController {
  @Get()
  @IgnoreTenant()
  ok() {
    return 1;
  }
}

describe('启动检查：多端接口', () => {
  it.each([
    [
      '用普通 @Controller，没指定端',
      PlainController,
      /PlainController 没有指定所属的端/,
    ],
    ['APP 端还没接入认证', MemberController, /app 端，这个端还没有接入认证/],
    [
      '@Public 的路径放在 /admin 下',
      SneakyPublicController,
      /是 @Public，路径 \/admin\/sneaky 不能在 \/admin 下/,
    ],
    [
      '@Public 接口用 @IgnoreTenant',
      PublicIgnoreController,
      /不能用 @IgnoreTenant/,
    ],
    [
      '后台控制器的方法上加 @Public',
      MethodPublicController,
      /MethodPublicController.sneaky 上加了 @Public/,
    ],
    [
      '@Public 控制器的方法路径落在 /admin 下',
      RootPublicController,
      /路径 \/admin\/review-public-root 不能在 \/admin 下/,
    ],
    [
      '继承来的方法路径落在 /admin 下',
      InheritedPublicController,
      /路径 \/admin\/inherited 不能在 \/admin 下/,
    ],
    [
      '@Public 路径用大小写混写绕过 /admin',
      MixedCasePublicController,
      /路径 \/admin\/review-case 不能在 \/admin 下/,
    ],
    [
      '后台控制器的方法上加 @Anonymous',
      MethodAnonymousController,
      /MethodAnonymousController.sneaky 上加了 @Anonymous/,
    ],
    [
      '@Anonymous 不属于任何端',
      AnonymousPublicController,
      /是 @Anonymous，但没有指定所属的端/,
    ],
    [
      '@Anonymous 接口用 @IgnoreTenant',
      AnonymousIgnoreController,
      /是 @Anonymous 接口，不能用 @IgnoreTenant/,
    ],
  ])('%s：启动失败', async (_name, controller, error) => {
    const moduleRef = await createTestModule({
      imports: [AppModule],
      controllers: [controller],
    }).compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await expect(app.init()).rejects.toThrow(error);
    await app.close().catch(() => undefined);
  });
});
