import { Inject, type OnModuleInit, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { BaseEntity } from './base.entity.js';
import { BaseService, type PageQuery } from './base.service.js';
import { buildCrudSchema } from './crud-schema.js';
import { CrudRuntime } from './crud.runtime.js';
import type { CrudControllerOptions, CrudResourceMeta } from './crud.types.js';

export const CRUD_RESOURCE = Symbol('crud:resource');

interface CrudClassMeta {
  options: CrudControllerOptions<BaseEntity>;
  meta: CrudResourceMeta;
}

/**
 * 通用 CRUD 控制器基类。和 @CrudController 一起用，接口按配置自动生成：
 *
 * @example
 *   @CrudController({ prefix: 'system/user', label: '用户', entity: UserEntity, api: ['page', 'info', 'add', 'update', 'delete'] })
 *   export class UserController extends BaseController<UserEntity> {}
 *
 * 需要钩子时写一个继承 BaseService 的 Service，放进模块的 providers，并在配置里写 service。
 */
export class BaseController<T extends BaseEntity> implements OnModuleInit {
  @Inject(CrudRuntime) private readonly crudRuntime: CrudRuntime;
  @Inject(ModuleRef) private readonly crudModuleRef: ModuleRef;
  protected service: BaseService<T>;

  async onModuleInit(): Promise<void> {
    const cls = Reflect.getMetadata(CRUD_RESOURCE, this.constructor) as
      CrudClassMeta | undefined;
    if (!cls)
      throw new Error(
        `${this.constructor.name} 继承了 BaseController，但没有加 @CrudController`,
      );
    const { options, meta } = cls;
    // 实体没在 TypeORM 里注册时，请求进来才报「找不到元数据」；在启动时就说清楚。
    // 导出接口文档时不连数据库，元数据没有建立，跳过这项检查
    const ds = this.crudRuntime.dataSource;
    if (ds.isInitialized)
      for (const e of [meta.entity, ...meta.children.map((c) => c.entity)])
        if (!ds.hasMetadata(e))
          throw new Error(
            `${meta.prefix} 用到的实体 ${e.name} 没有注册：请在模块里加上 TypeOrmModule.forFeature([${e.name}])`,
          );
    let service: BaseService<T>;
    if (options.service) {
      service = this.crudModuleRef.get(options.service, {
        strict: false,
      }) as BaseService<T>;
      if (!(service instanceof BaseService))
        throw new Error(
          `${options.service.name} 必须继承 BaseService，才能作为 ${meta.prefix} 的 service`,
        );
    } else {
      service = new BaseService<T>();
    }
    service.bindCrud({
      dataSource: this.crudRuntime.dataSource,
      scope: this.crudRuntime.scope,
      context: this.crudRuntime.context,
      meta: meta as CrudResourceMeta<T>,
      childOwner: (entity) => this.crudRuntime.childOwner(entity),
    });
    this.crudRuntime.register(meta);
    this.service = service;
  }

  // 下面的方法由 @CrudController 按配置挂上路由；没开放的接口不会有路由

  page(body: PageQuery) {
    return this.service.page(body);
  }

  info(body: { id: string }) {
    return this.service.info(body.id);
  }

  add(body: { data: Partial<T>; children?: unknown }) {
    return this.service.add(body.data, body.children);
  }

  update(body: {
    id: string;
    version: number;
    data: Partial<T>;
    children?: unknown;
  }) {
    return this.service.update(body.id, body.version, body.data, body.children);
  }

  delete(body: { ids: string[] }) {
    return this.service.delete(body.ids);
  }

  schema() {
    return buildCrudSchema(this.service.meta as CrudResourceMeta);
  }
}

export type BaseControllerClass = Type<BaseController<BaseEntity>>;
