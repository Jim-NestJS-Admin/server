import {
  Injectable,
  RequestMethod,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { DiscoveryService, ExternalContextCreator } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import type { OpenAPIObject } from '@nestjs/swagger';
import { CrudRuntime } from '../crud/crud.runtime.js';
import { crudErrors } from '../crud/crud.errors.js';
import { PERMS_KEY, type PermMeta } from '../permission/perms.decorator.js';
import {
  ENDPOINT_KEY,
  ANONYMOUS_KEY,
  IGNORE_TENANT_KEY,
} from './endpoint.decorators.js';
import { RAW_RESPONSE } from '../decorators/raw-response.decorator.js';
import type { Principal } from '../tenant/request-context.js';
import { InternalAction } from './internal-action.js';
import { TenantRepositoryFactory } from '../tenant/tenant-repository.js';
import type { EntityManager } from 'typeorm';
import type { CrudAction } from '../crud/crud.types.js';
import { RequestContext } from '../tenant/request-context.js';
import { fieldVerdict } from '../field-perm/field-policy.js';

export interface RegisteredAction {
  resource: string;
  action: string;
  path: string;
  method: 'GET' | 'POST';
  permission: string;
  risk: boolean;
  read: boolean;
  invoke(
    principal: Principal,
    input: Record<string, unknown>,
  ): Promise<unknown>;
}
/** 框架适配层：发现已有路由，以同一Nest守卫、拦截器、参数管道执行，不复制业务逻辑。 */
@Injectable()
export class ActionRegistry implements OnApplicationBootstrap {
  private readonly actions: RegisteredAction[] = [];
  document?: () => OpenAPIObject;
  private apiDocument?: OpenAPIObject;
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly external: ExternalContextCreator,
    private readonly internal: InternalAction,
    private readonly cls: ClsService,
    readonly crud: CrudRuntime,
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
  ) {}
  onApplicationBootstrap() {
    for (const wrapper of this.discovery.getControllers()) {
      const cls = wrapper.metatype;
      const instance = wrapper.instance as
        Record<string, (...args: unknown[]) => unknown> | undefined;
      if (
        !cls ||
        !instance ||
        Reflect.getMetadata(ENDPOINT_KEY, cls) !== 'admin' ||
        Reflect.getMetadata(ANONYMOUS_KEY, cls)
      )
        continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, cls)).replace(
        /^\/?admin\//,
        '',
      );
      if (/^(platform|dev|mcp)(\/|$)/.test(base)) continue;
      const seen = new Set<string>();
      for (
        let proto = cls.prototype as object | null;
        proto && proto !== Object.prototype;
        proto = Object.getPrototypeOf(proto) as object | null
      )
        for (const name of Object.getOwnPropertyNames(proto)) {
          if (seen.has(name)) continue;
          seen.add(name);
          const fn = instance[name];
          if (typeof fn !== 'function') continue;
          const perm = Reflect.getMetadata(PERMS_KEY, fn) as
            PermMeta | undefined;
          if (
            !perm ||
            /^(platform|dev):/.test(perm.code) ||
            Reflect.getMetadata(IGNORE_TENANT_KEY, fn) ||
            Reflect.getMetadata(RAW_RESPONSE, fn)
          )
            continue;
          const method = Reflect.getMetadata(METHOD_METADATA, fn) as
            RequestMethod | undefined;
          if (method !== RequestMethod.GET && method !== RequestMethod.POST)
            continue;
          const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, name) ??
            {}) as Record<string, { index: number; data?: string }>;
          // 流、文件、会话与原始Req/Res不是JSON业务动作，不能伪造HTTP环境来开放。
          if (
            Object.keys(args).some(
              (key) => !['3', '4'].includes(key.split(':')[0]!),
            )
          )
            continue;
          const path = String(Reflect.getMetadata(PATH_METADATA, fn) ?? '');
          if (path.includes(':') || path.includes('*')) continue;
          const resource = base.replaceAll('/', '.');
          const read =
            perm.risk !== 'high' &&
            ([
              'page',
              'info',
              'tree',
              'schema',
              'recyclePage',
              'result',
              'document',
              'preview',
              'inspect',
              'available',
              'validate',
            ].includes(name) ||
              method === RequestMethod.GET);
          const invoke = this.external.create(
            instance,
            fn,
            name,
            ROUTE_ARGS_METADATA,
            {
              exchangeKeyForValue: (type, data, values: unknown[]) => {
                const req = values[0] as { body: unknown; query: unknown };
                const value = type === 3 ? req.body : req.query;
                return typeof data === 'string' || typeof data === 'number'
                  ? (value as Record<string, unknown>)[data]
                  : value;
              },
            },
            undefined,
            undefined,
            { guards: true, interceptors: true, filters: false },
            'http',
          );
          this.actions.push({
            resource,
            action: path || name,
            path: `/admin/${base}/${path}`,
            method: method === RequestMethod.GET ? 'GET' : 'POST',
            permission: perm.code,
            risk: perm.risk === 'high',
            read,
            invoke: (principal, input) =>
              this.cls.runWith({}, async () => {
                const req = {
                  method: method === RequestMethod.GET ? 'GET' : 'POST',
                  path: `/admin/${base}/${path}`,
                  url: `/admin/${base}/${path}`,
                  originalUrl: `/admin/${base}/${path}`,
                  headers: {},
                  header() {
                    return undefined;
                  },
                  get() {
                    return undefined;
                  },
                  body: input,
                  query: input,
                  params: {},
                  ip: `mcp:${principal.tenantId}:${principal.userId}`,
                  socket: {},
                };
                this.internal.bind(req, principal);
                const response = (await invoke(
                  req,
                  {
                    setHeader() {},
                    getHeader() {
                      return undefined;
                    },
                  },
                  () => undefined,
                )) as { code?: number; data?: unknown };
                return response?.code === 1000 ? response.data : response;
              }),
          });
        }
    }
  }
  all() {
    return [...this.actions];
  }
  inputSchema(action: RegisteredAction): unknown {
    this.apiDocument ??= this.document?.();
    const api = this.apiDocument;
    const operation =
      api?.paths[action.path]?.[action.method === 'GET' ? 'get' : 'post'];
    const body = operation?.requestBody;
    let schema: unknown =
      body && !('$ref' in body)
        ? body.content['application/json']?.schema
        : undefined;
    if (action.method === 'GET') {
      const parameters = (operation?.parameters ?? []).filter(
        (parameter) => !('$ref' in parameter) && parameter.in === 'query',
      );
      schema = {
        type: 'object',
        properties: Object.fromEntries(
          parameters.flatMap((parameter) =>
            '$ref' in parameter
              ? []
              : [[parameter.name, parameter.schema ?? { type: 'string' }]],
          ),
        ),
        required: parameters.flatMap((parameter) =>
          !('$ref' in parameter) && parameter.required ? [parameter.name] : [],
        ),
        additionalProperties: false,
      };
    }
    const meta = this.crud.get(action.resource.replaceAll('.', '/')),
      authz = this.crud.authz.get();
    const hidden = new Set(
      meta && authz
        ? meta.fields
            .filter(
              (field) =>
                fieldVerdict(
                  authz,
                  this.context.current().userId,
                  meta.permPrefix,
                  meta.entity,
                  field.property,
                  meta.dataScope,
                  null,
                ).state === 'hidden',
            )
            .map((field) => field.property)
        : [],
    );
    const expand = (value: unknown, depth = 0): unknown => {
      if (depth > 9)
        return { type: 'object', description: '嵌套格式沿用同一CRUD协议' };
      if (Array.isArray(value))
        return value.map((item) => expand(item, depth + 1));
      if (!value || typeof value !== 'object') return value;
      const record = value as Record<string, unknown>;
      if (typeof record.$ref === 'string')
        return expand(
          api?.components?.schemas?.[record.$ref.split('/').at(-1)!] ?? {
            type: 'object',
          },
          depth + 1,
        );
      return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [
          key,
          key === 'properties' && item && typeof item === 'object'
            ? Object.fromEntries(
                Object.entries(item)
                  .filter(([name]) => !hidden.has(name))
                  .map(([name, definition]) => [
                    name,
                    expand(definition, depth + 1),
                  ]),
              )
            : key === 'required' && Array.isArray(item)
              ? item.filter((name) => !hidden.has(String(name)))
              : expand(item, depth + 1),
        ]),
      );
    };
    return schema
      ? expand(schema)
      : { type: 'object', additionalProperties: false };
  }
  async targets(
    action: RegisteredAction,
    input: Record<string, unknown>,
    manager?: EntityManager,
  ) {
    const ids = [
      ...new Set(
        [
          input.id,
          input.taskId,
          ...(Array.isArray(input.ids) ? input.ids : []),
          ...(Array.isArray(input.items)
            ? input.items.map((item) => (item as { id?: unknown }).id)
            : []),
        ].filter((id): id is string => typeof id === 'string'),
      ),
    ].sort();
    if (ids.some((id) => !/^[1-9]\d{0,19}$/.test(id)) || ids.length > 100)
      throw crudErrors.badRequest('目标编号无效');
    if (!ids.length) return [];
    const meta = this.crud.get(action.resource.replaceAll('.', '/'));
    if (!meta) throw crudErrors.badRequest('该动作尚无可验证的目标资源');
    const query = this.repos
      .for(meta.entity)
      .query('e', manager)
      .andWhere('e.id IN (:...ids)', { ids });
    const ctx = { ...this.crud.context.current(), endpoint: 'admin' as const };
    for (const condition of this.crud.scope.conditions(
      ctx,
      meta,
      action.action as CrudAction,
      'e',
    ))
      query.andWhere(condition.sql, condition.params);
    if (manager) query.setLock('pessimistic_write');
    const rows = await query.getMany();
    if (rows.length !== ids.length) throw crudErrors.notFound();
    return rows
      .map((row) => ({ id: row.id, version: row.version }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  preview(action: RegisteredAction, input: Record<string, unknown>) {
    const meta = this.crud.get(action.resource.replaceAll('.', '/'));
    const authz = this.crud.authz.get();
    const scrub = (value: unknown, key = '', depth = 0): unknown => {
      if (
        depth > 8 ||
        /password|secret|token|credential|authorization|privateKey|apiKey|patch|values/i.test(
          key,
        )
      )
        return '【敏感内容已隐藏】';
      if (
        meta &&
        authz &&
        meta.fields.some((field) => field.property === key)
      ) {
        const verdict = fieldVerdict(
          authz,
          this.context.current().userId,
          meta.permPrefix,
          meta.entity,
          key,
          meta.dataScope,
          null,
        );
        if (verdict.state === 'hidden' || verdict.state === 'masked')
          return '【无原值查看权限】';
      }
      if (Array.isArray(value))
        return value.map((item) => scrub(item, key, depth + 1));
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([name, item]) => [
            meta?.fields.find((field) => field.property === name)?.label ??
              (
                {
                  id: '目标编号',
                  ids: '目标编号列表',
                  version: '版本',
                  data: '拟修改字段',
                  children: '明细变更',
                } as Record<string, string>
              )[name] ??
              name,
            scrub(item, name, depth + 1),
          ]),
        );
      return value;
    };
    return scrub(input) as Record<string, unknown>;
  }
  summary(action: RegisteredAction) {
    this.apiDocument ??= this.document?.();
    return (
      this.apiDocument?.paths[action.path]?.[
        action.method === 'GET' ? 'get' : 'post'
      ]?.summary ??
      `${this.crud.get(action.resource.replaceAll('.', '/'))?.label ?? action.resource}：${action.action}`
    );
  }
  get(resource: string, action: string) {
    const found = this.actions.find(
      (item) => item.resource === resource && item.action === action,
    );
    if (!found) throw crudErrors.notFound();
    return found;
  }
}
