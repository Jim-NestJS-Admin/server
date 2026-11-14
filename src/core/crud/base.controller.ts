import {
  Inject,
  type OnModuleInit,
  type Type,
  Optional,
  StreamableFile,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EntityMetadata } from 'typeorm';
import type { BaseEntity } from './base.entity.js';
import {
  BaseService,
  type PageQuery,
  type ExportQuery,
} from './base.service.js';
import { buildCrudSchema } from './crud-schema.js';
import { SYSTEM_FIELDS } from './base.entity.js';
import { fieldVerdict } from '../field-perm/field-policy.js';
import { mergeView } from '../page-config/page-config.rules.js';
import { PageViewSource } from '../page-config/page-config.service.js';
import { CrudRuntime } from './crud.runtime.js';
import type { CrudControllerOptions, CrudResourceMeta } from './crud.types.js';

export const CRUD_RESOURCE = Symbol('crud:resource');

/**
 * 唯一约束必须带租户；软删除的表还必须带 activeGuard（架构「删除方式 · 唯一字段的处理」），
 * 否则删掉的记录占着业务键，删除后不能重用，恢复时撞名也查不出来。启动时检查，写错直接报错。
 */
function checkUniqueIndexes(
  em: EntityMetadata,
  prefix: string,
  deleteMode: 'soft' | 'hard',
): void {
  const groups = [
    ...em.indices
      .filter((i) => i.isUnique)
      .map((i) => ({ name: i.name, columns: i.columns })),
    ...em.uniques.map((u) => ({ name: u.name, columns: u.columns })),
  ];
  for (const g of groups) {
    const props = g.columns.map((c) => c.propertyName);
    const need =
      deleteMode === 'soft' ? ['tenantId', 'activeGuard'] : ['tenantId'];
    const missing = need.filter((p) => !props.includes(p));
    if (missing.length)
      throw new Error(
        `${prefix} 的实体 ${em.name} 唯一约束 ${g.name}（${props.join(', ')}）缺少 ${missing.join('、')}：` +
          `唯一约束要建在「租户 + 业务字段${deleteMode === 'soft' ? ' + activeGuard' : ''}」上`,
      );
  }
}

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
  /** 在线页面配置（T23）；没装配时页面描述不带 view */
  @Optional()
  @Inject(PageViewSource)
  private readonly pageViews?: PageViewSource;
  protected service: BaseService<T>;

  private ownService(type: Function): unknown {
    try {
      return this.crudModuleRef.get(type, { strict: true });
    } catch {
      return this.crudModuleRef.get(type, { strict: false });
    }
  }

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
    if (ds.isInitialized)
      for (const e of [meta.entity, ...meta.children.map((c) => c.entity)])
        checkUniqueIndexes(ds.getMetadata(e), meta.prefix, meta.deleteMode);
    let service: BaseService<T>;
    if (options.service) {
      // 先取控制器所在模块里的实例：同一个动态模块装配了多次时（例如测试里），
      // 每个控制器绑定自己模块的 Service，不会绑到别的实例上、留下没绑定的那个
      service = this.ownService(options.service) as BaseService<T>;
      if (!(service instanceof BaseService))
        throw new Error(
          `${options.service.name} 必须继承 BaseService，才能作为 ${meta.prefix} 的 service`,
        );
    } else {
      service = new BaseService<T>();
    }
    service.bindCrud({
      codes: () => this.crudRuntime.codes,
      dataSource: this.crudRuntime.dataSource,
      scope: this.crudRuntime.scope,
      context: this.crudRuntime.context,
      meta: meta as CrudResourceMeta<T>,
      childOwner: (entity) => this.crudRuntime.childOwner(entity),
      audit: this.crudRuntime.audit,
      authz: this.crudRuntime.authz,
      idempotency: this.crudRuntime.idempotency,
      display: () => this.crudRuntime.display,
      dictionary: () => this.crudRuntime.dictionary,
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

  tree() {
    return this.service.tree();
  }

  recyclePage(body: { page?: number; size?: number; keyword?: string }) {
    return this.service.recyclePage(body);
  }

  restore(body: { items: { id: string; version: number }[] }) {
    return this.service.restore(body.items);
  }

  purge(body: { items: { id: string; version: number }[] }) {
    return this.service.purge(body.items);
  }

  /**
   * 页面描述 + fieldPerms：本页面（列表权限的本次有效角色）下每个字段可能的最宽状态，
   * 前端据此决定列和表单项是否出现、是否只读；逐行的真实状态以数据为准（契约 field-perm.md）。
   */
  /** 导出 CSV（T18）：和列表同样的查询条件和数据范围，逐行按字段权限隐藏 / 打码，单元格防公式注入 */
  async export(body: ExportQuery) {
    if (body.columns === undefined) {
      const schema = await this.schema();
      const view = schema.view as ReturnType<typeof mergeView> | undefined;
      // 只导出列表里有的列（list: false 的字段如头像不导出），顺序和显隐跟生效的显示配置
      const listed = new Set(schema.columns.map((column) => column.field));
      body = {
        ...body,
        columns: (view?.list.columns ?? schema.columns)
          .filter((column) => !column.hidden && listed.has(column.field))
          .map((column) => column.field),
      };
    }
    const format = body.format ?? 'csv';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const filename = encodeURIComponent(
      `${this.service.meta.label}_${stamp.slice(0, 8)}_${stamp.slice(8)}.${format}`,
    );
    const data =
      format === 'xlsx'
        ? await this.service.exportXlsx(body)
        : Buffer.from(await this.service.exportCsv(body), 'utf8');
    const options = {
      type:
        format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv; charset=utf-8',
      disposition: `attachment; filename="export.${format}"; filename*=UTF-8''${filename}`,
    };
    return Buffer.isBuffer(data)
      ? new StreamableFile(data, options)
      : new StreamableFile(data, options);
  }

  async schema() {
    const meta = this.service.meta as CrudResourceMeta;
    const authz = this.crudRuntime.authz.get();
    const ctx = this.crudRuntime.context.current();
    const exempt = new Set<string>([...SYSTEM_FIELDS, 'version']);
    const fieldPerms = Object.fromEntries(
      meta.readable
        .filter((f) => !exempt.has(f))
        .map((f) => [
          f,
          authz
            ? fieldVerdict(
                authz,
                ctx.userId,
                meta.permPrefix,
                meta.entity,
                f,
                meta.dataScope,
                null,
              )
            : { state: 'hidden', mask: null },
        ]),
    );
    const schema = Object.assign(buildCrudSchema(meta), { fieldPerms });
    for (const field of meta.fields)
      if (field.dictCode)
        schema.dictionaries[field.property] =
          (await this.crudRuntime.dictionary?.options(field.dictCode)) ?? [];
    for (const child of meta.children)
      for (const field of child.fields)
        if (field.dictCode)
          schema.dictionaries[`${child.resource}.${field.property}`] =
            (await this.crudRuntime.dictionary?.options(field.dictCode)) ?? [];
    if (!this.pageViews) return schema;
    // 生效的显示配置：代码默认 → 管理员 → 用户列设置，最后按字段权限裁剪（契约 page-config.md）
    const { admin, user, canWrite } = await this.pageViews.load(meta);
    const state = (f: string) =>
      (fieldPerms[f] as { state: string } | undefined)?.state ?? 'editable';
    return Object.assign(schema, {
      view: mergeView(meta, admin, user, state, canWrite),
      // 不含用户列设置的模块显示配置：前端「列设置」据此只保存用户改过的部分、恢复默认
      moduleView: mergeView(meta, admin, null, state, canWrite),
    });
  }
}

export type BaseControllerClass = Type<BaseController<BaseEntity>>;
