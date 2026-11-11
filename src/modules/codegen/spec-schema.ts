import { getMetadataArgsStorage } from 'typeorm';
import { BaseEntity } from '../../core/crud/base.entity.js';
import { buildCrudSchema } from '../../core/crud/crud-schema.js';
import { crudResourceName } from '../../core/crud/crud-meta.js';
import type {
  CrudFieldMeta,
  FormComponent,
} from '../../core/crud/crud-field.decorator.js';
import type {
  CrudResourceMeta,
  CrudChildMeta,
  CrudApi,
} from '../../core/crud/crud.types.js';
import { defaultComponent } from './render-server.js';
import { specToConfig, type ModuleSpec } from './module-spec.js';
import type { CodegenField } from './codegen.types.js';

/** 复用正式 CrudSchema 构建器；临时列元数据只在同步调用内存在，不注册资源或执行生成代码。 */
export function specSchema(spec: ModuleSpec) {
  const c = specToConfig(spec);
  const columns = getMetadataArgsStorage().columns;
  const temporary = new Set<Function>();
  const base = [
    'id',
    'version',
    'orgId',
    'createdBy',
    'updatedBy',
    'createdAt',
    'updatedAt',
  ];
  const make = (fields: CodegenField[], parent?: string) => {
    class PreviewEntity extends BaseEntity {}
    temporary.add(PreviewEntity);
    const meta: CrudFieldMeta[] = fields.map((f) => {
      const isParent = f.name === parent;
      const designType =
        isParent || f.type === 'reference'
          ? String
          : f.type === 'int'
            ? Number
            : f.type === 'boolean'
              ? Boolean
              : f.type === 'datetime'
                ? Date
                : f.type === 'json'
                  ? Object
                  : String;
      Reflect.defineMetadata(
        'design:type',
        designType,
        PreviewEntity.prototype,
        f.name,
      );
      columns.push({
        target: PreviewEntity,
        propertyName: f.name,
        mode: 'regular',
        options: {
          type:
            f.type === 'date' ? 'date' : f.type === 'json' ? 'json' : 'varchar',
        },
      });
      return {
        property: f.name,
        label: f.label,
        ...(f.list === false || isParent
          ? { list: false as const }
          : f.type !== 'json'
            ? { list: { sortable: true } }
            : {}),
        form:
          f.form === false
            ? false
            : {
                component: (isParent
                  ? 'tree-select'
                  : defaultComponent(f)) as FormComponent,
                required: isParent ? undefined : !!f.required,
              },
        ...(f.nullable || isParent ? { nullable: true } : {}),
        ...(f.dict ? { dictCode: f.dict } : {}),
      };
    });
    return { entity: PreviewEntity, fields: meta };
  };
  try {
    const main = make(c.fields, c.tree?.parentField);
    const prefix = c.permPrefix.replace(/:/g, '/');
    const name = crudResourceName(prefix);
    const children: CrudChildMeta[] = (c.children ?? []).map((ch) => {
      const business = ch.table.startsWith(`${c.module}_`)
        ? ch.table.slice(c.module.length + 1)
        : ch.table;
      const resource = business.replace(/_([a-z])/g, (_, s: string) =>
        s.toUpperCase(),
      );
      const child = make(ch.fields);
      const props = ch.fields.map((f) => f.name);
      return {
        ...child,
        resource,
        label: ch.label,
        name: `${name}${resource[0].toUpperCase()}${resource.slice(1)}`,
        foreignKey: ch.foreignKey,
        addable: props,
        updatable: props,
        readable: [...base.filter((f) => f !== 'version'), ...props],
        min: 0,
        max: 500,
        unique: [],
      };
    });
    const props = c.fields.map((f) => f.name);
    const api: CrudApi[] = [
      'page',
      'info',
      'add',
      'update',
      'delete',
      ...(c.options?.deleteMode === 'hard'
        ? []
        : (['recycle', 'restore', 'purge'] as CrudApi[])),
      ...(c.options?.export ? (['export'] as CrudApi[]) : []),
      ...(c.tree ? (['tree'] as CrudApi[]) : []),
    ];
    const meta: CrudResourceMeta = {
      ...main,
      prefix,
      label: c.label,
      name,
      permPrefix: c.permPrefix,
      dataScope: c.options?.dataScope ?? false,
      api,
      deleteMode: c.options?.deleteMode ?? 'soft',
      addable: props,
      updatable: props,
      readable: [...base, ...props],
      sortable: [
        'id',
        'createdAt',
        'updatedAt',
        ...main.fields
          .filter((f) => f.list && f.list.sortable)
          .map((f) => f.property),
      ],
      keyWords: c.fields.filter((f) => f.query === 'like').map((f) => f.name),
      fieldEq: c.fields
        .filter((f) => f.query && f.query !== 'like')
        .map((f) => f.name),
      defaultSort: [{ field: 'id', order: 'desc' }],
      maxSize: 500,
      children,
      tree: c.tree ?? null,
      systemColumns: { createdAt: true },
    };
    return buildCrudSchema(meta);
  } finally {
    // 避免每次预览向 TypeORM 全局注册表积累临时实体。
    for (let i = columns.length - 1; i >= 0; i--)
      if (temporary.has(columns[i].target as Function)) columns.splice(i, 1);
  }
}
