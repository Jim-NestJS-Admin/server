import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  type Type,
} from '@nestjs/common';
import {
  ApiBody,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors, ApiResult } from '../swagger/api-result.js';
import type { BaseEntity } from './base.entity.js';
import { CRUD_RESOURCE } from './base.controller.js';
import { buildCrudDtos } from './crud.dto.js';
import { resolveCrudMeta } from './crud-meta.js';
import { CrudSchema, CrudSchemaDictItem } from './crud-schema.js';
import type { CrudControllerOptions } from './crud.types.js';

type Method = 'page' | 'info' | 'add' | 'update' | 'delete' | 'schema';

interface RouteSpec {
  method: Method;
  http: 'get' | 'post';
  summary: string;
  body?: Type;
  result?: Type;
  errors: (400 | 404 | 409)[];
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * 声明一个通用 CRUD 资源（架构「通用 CRUD」）。按 api 配置生成 /admin/<prefix>/<动作> 接口、
 * 参数校验、接口文档（operationId 如 systemUserPage）和页面描述 /admin/<prefix>/schema。
 *
 * 接口约定：除页面描述外都是 POST，参数放请求体。
 * - page   { page, size, keyword, sort: [{ field, order }], eq: { 字段: 值 } } → { list, total, page, size }
 * - info   { id }
 * - add    { data: {...} }
 * - update { id, version, data: { 只传要改的字段 } }
 * - delete { ids: [...] }，整批成败
 *
 * 子类自己写了同名方法时，路由挂在子类的方法上（第 3 级定制）。
 */
export function CrudController<T extends BaseEntity>(
  options: CrudControllerOptions<T>,
): ClassDecorator {
  return (target) => {
    const meta = resolveCrudMeta(options);
    const dtos = buildCrudDtos(meta);
    const label = meta.label;
    const specs: RouteSpec[] = [
      {
        method: 'page',
        http: 'post',
        summary: `${label}分页列表`,
        body: dtos.PageBody,
        result: dtos.PageResult,
        errors: [400],
      },
      {
        method: 'info',
        http: 'post',
        summary: `${label}详情`,
        body: dtos.InfoBody,
        result: dtos.Row,
        errors: [400, 404],
      },
      {
        method: 'add',
        http: 'post',
        summary: `新增${label}`,
        body: dtos.AddBody,
        result: dtos.Row,
        errors: [400],
      },
      {
        method: 'update',
        http: 'post',
        summary: `修改${label}`,
        body: dtos.UpdateBody,
        result: dtos.Row,
        errors: [400, 404, 409],
      },
      {
        method: 'delete',
        http: 'post',
        summary: `删除${label}（整批成败）`,
        body: dtos.DeleteBody,
        result: dtos.DeleteResult,
        errors: [400, 404],
      },
    ];
    const enabled = specs.filter((s) => meta.api.includes(s.method as never));
    enabled.push({
      method: 'schema',
      http: 'get',
      summary: `${label}页面描述`,
      result: CrudSchema,
      errors: [],
    });

    const proto = target.prototype as Record<string, unknown>;
    for (const spec of enabled) {
      // 子类没写同名方法时，在子类上放一个调用基类实现的方法，路由元数据挂在它上面
      if (!Object.prototype.hasOwnProperty.call(proto, spec.method)) {
        const base = (
          Object.getPrototypeOf(proto) as Record<
            string,
            (...a: unknown[]) => unknown
          >
        )[spec.method];
        if (typeof base !== 'function')
          throw new Error(`${target.name} 必须继承 BaseController`);
        Object.defineProperty(proto, spec.method, {
          value: function (this: unknown, ...args: unknown[]) {
            return base.apply(this, args);
          },
          writable: true,
          configurable: true,
        });
      }
      const descriptor = Object.getOwnPropertyDescriptor(proto, spec.method)!;
      const decorators: MethodDecorator[] = [
        spec.http === 'get' ? Get(spec.method) : Post(spec.method),
        HttpCode(HttpStatus.OK),
        ApiOperation({
          operationId: `${lowerFirst(meta.name)}${spec.method.charAt(0).toUpperCase()}${spec.method.slice(1)}`,
          summary: spec.summary,
        }),
        ApiResult(spec.result),
        ...(spec.errors.length ? [ApiErrors(...spec.errors)] : []),
      ];
      // 页面描述里字典项是按 $ref 引用的，要单独登记模型，否则文档里是悬空引用
      if (spec.method === 'schema')
        decorators.push(ApiExtraModels(CrudSchemaDictItem));
      if (spec.body) {
        decorators.push(ApiBody({ type: spec.body }));
        Body()(proto, spec.method, 0);
        Reflect.defineMetadata(
          'design:paramtypes',
          [spec.body],
          proto,
          spec.method,
        );
      } else {
        Reflect.defineMetadata('design:paramtypes', [], proto, spec.method);
      }
      for (const d of decorators) d(proto, spec.method, descriptor);
    }

    Reflect.defineMetadata(CRUD_RESOURCE, { options, meta }, target);
    ApiTags(`${meta.prefix} ${label}`)(target);
    Controller(`admin/${meta.prefix}`)(target);
  };
}
