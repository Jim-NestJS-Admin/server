import type { CodegenConfig, CodegenField } from './codegen.types.js';
import { tableDefinition } from './table-definition.js';
import { uniqueIndexName } from './sql-values.js';
export { sqlDefault, uniqueIndexName } from './sql-values.js';

export interface GeneratedFile {
  project: 'server' | 'admin';
  /** 相对项目根目录，正斜杠 */
  path: string;
  content: string;
}

const pascal = (s: string) =>
  s.replace(/(^|_)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
const camel = (s: string) => pascal(s).replace(/^./, (c) => c.toLowerCase());
const kebab = (s: string) => s.replace(/_/g, '-');
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/** 子表的业务名：表名去掉模块前缀，如 crm_customer_contact → customer_contact */
const childBusiness = (c: CodegenConfig, table: string) =>
  table.startsWith(`${c.module}_`) ? table.slice(c.module.length + 1) : table;
/** 文字一律按 JSON 字符串转义写进代码，不会拼成可执行的内容 */
const lit = (s: unknown) => JSON.stringify(s);
export const defaultComponent = (f: CodegenField) =>
  f.dict || f.type === 'dictionary'
    ? 'select'
    : f.type === 'text'
      ? 'textarea'
      : ['int', 'decimal', 'money'].includes(f.type)
        ? 'number'
        : f.type === 'boolean'
          ? 'switch'
          : f.type === 'date'
            ? 'date'
            : f.type === 'datetime'
              ? 'datetime'
              : 'input';

function column(
  f: CodegenField,
  asId = false,
): {
  ts: string;
  col: string;
  validators: string[];
} {
  // 树表的父级字段：和编号一样是 bigint，按字符串处理，根节点为空
  if (asId)
    return {
      ts: 'string',
      col: `{ type: 'bigint', unsigned: true, nullable: true }`,
      validators: ['@IsOptional()', '@Matches(/^[1-9]\\d{0,19}$/)'],
    };
  const nullable =
    (f.nullable ? ', nullable: true' : '') +
    (Object.hasOwn(f, 'defaultValue')
      ? `, default: ${lit(f.defaultValue)}`
      : '') +
    (f.comment !== undefined ? `, comment: ${lit(f.comment)}` : '');
  const v: string[] = [];
  if (!f.required) v.push('@IsOptional()');
  switch (f.type) {
    case 'reference':
      return {
        ts: 'string',
        col: `{ type: 'bigint', unsigned: true${nullable} }`,
        validators: [...v, '@Matches(/^[1-9]\\d{0,19}$/)'],
      };
    case 'text':
      return {
        ts: 'string',
        col: `{ type: 'text'${nullable} }`,
        validators: [...v, '@IsString()', '@MaxLength(65535)'],
      };
    case 'int':
      return {
        ts: 'number',
        col: `{ type: 'int'${nullable} }`,
        validators: [...v, '@IsInt()'],
      };
    case 'decimal':
    case 'money':
      return {
        ts: 'string',
        col: `{ type: 'decimal', precision: ${f.precision ?? 14}, scale: ${f.scale ?? (f.type === 'money' ? 2 : 4)}${nullable} }`,
        validators: [
          ...v,
          `@DecimalInput({ label: ${lit(f.label)}, precision: ${f.precision ?? 14}, scale: ${f.scale ?? (f.type === 'money' ? 2 : 4)} })`,
        ],
      };
    case 'date':
      return {
        ts: 'string',
        col: `{ type: 'date'${nullable} }`,
        validators: [...v, '@IsDateString()'],
      };
    case 'datetime':
      return {
        ts: 'Date',
        col: `{ type: 'datetime', precision: 3${nullable} }`,
        validators: [...v, '@IsDateString()'],
      };
    case 'boolean':
      return {
        ts: 'boolean',
        col: `{ type: 'boolean'${nullable} }`,
        validators: [...v, '@IsBoolean()'],
      };
    case 'json':
      return {
        ts: 'unknown',
        col: `{ type: 'json'${nullable} }`,
        validators: [...v, '@Allow()'],
      };
    default: {
      const len =
        f.length ?? (f.type === 'image' || f.type === 'file' ? 2048 : 255);
      return {
        ts: 'string',
        col: `{ type: 'varchar', length: ${len}${nullable} }`,
        validators: [...v, '@IsString()', `@MaxLength(${len})`],
      };
    }
  }
}

function entity(
  c: Pick<CodegenConfig, 'module' | 'business' | 'table' | 'fields'>,
  foreignKey?: string,
  treeParent?: string,
): string {
  const name = `${pascal(c.business)}Entity`;
  const uniques = c.fields.filter((f) => f.unique);
  const fk = foreignKey
    ? `  /** 指向主表编号，由框架填写，前端不能传 */\n  @Column({ name: ${lit(snake(foreignKey))}, type: 'bigint', unsigned: true })\n  ${foreignKey}: string;\n\n`
    : '';
  const body = c.fields
    .map((f) => {
      const isParent = f.name === treeParent;
      const { ts, col, validators } = column(f, isParent);
      const crud: string[] = [`label: ${lit(f.label)}`];
      if (f.list === false || isParent) crud.push('list: false');
      else if (f.type !== 'json') crud.push('list: { sortable: true }');
      if (f.form === false) crud.push('form: false');
      else if (isParent) crud.push("form: { component: 'tree-select' }");
      else
        crud.push(
          `form: { component: ${lit(defaultComponent(f))}, required: ${!!f.required} }`,
        );
      if (f.nullable || isParent) crud.push('nullable: true');

      const perm = f.fieldPerm?.default
        ? `  @FieldPerm({ label: ${lit(f.label)}, default: ${lit(f.fieldPerm.default)}${f.fieldPerm.mask ? `, mask: ${lit(f.fieldPerm.mask)}` : ''} })\n`
        : '';
      if (f.dict) crud.push(`dictCode: ${lit(f.dict)}`);
      return `  @CrudField({ ${crud.join(', ')} })\n${perm}${validators.map((x) => `  ${x}\n`).join('')}  @Column(${col.replace('{ ', `{ name: ${lit(f.column)}, `)})\n  ${f.name}: ${ts}${f.nullable || isParent ? ' | null' : ''};`;
    })
    .join('\n\n');
  const idx = uniques
    .map(
      (f) =>
        `@Index(${lit(uniqueIndexName(c.table, f.column))}, ['tenantId', ${lit(f.name)}, 'activeGuard'], { unique: true })\n`,
    )
    .join('');
  const used = new Set([
    'Column',
    'Entity',
    ...(uniques.length ? ['Index'] : []),
  ]);
  const validators = new Set<string>();
  for (const f of c.fields)
    for (const v of column(f, f.name === treeParent).validators)
      if (!v.startsWith('@DecimalInput'))
        validators.add(v.replace(/^@(\w+).*/, '$1'));
  return `// 由代码生成器生成（${c.module}.${c.business}），可以继续手改；再次生成时手改过的文件默认不覆盖
import { ${[...validators].sort().join(', ')} } from 'class-validator';
import { ${[...used].sort().join(', ')} } from 'typeorm';
import { BaseEntity, CrudField${c.fields.some((f) => f.type === 'decimal' || f.type === 'money') ? ', DecimalInput' : ''} } from '../../../core/crud/index.js';
${c.fields.some((f) => f.fieldPerm?.default) ? "import { FieldPerm } from '../../../core/field-perm/field-perm.decorator.js';\n" : ''}
@Entity(${lit(c.table)})
${idx}export class ${name} extends BaseEntity {
${fk}${body}
}
`;
}

function controller(c: CodegenConfig): string {
  const name = pascal(c.business);
  const tree = c.template === 'tree' ? c.tree : null;
  const treeOption = tree
    ? `\n  tree: { parentField: ${lit(tree.parentField)}, nameField: ${lit(tree.nameField)}${tree.sortField ? `, sortField: ${lit(tree.sortField)}` : ''} },`
    : '';
  const kids = c.template === 'master-detail' ? (c.children ?? []) : [];
  const kidImports = kids
    .map((k) => {
      const b = childBusiness(c, k.table);
      return `import { ${pascal(b)}Entity } from '../../entity/${b}.entity.js';\n`;
    })
    .join('');
  const kidOptions = kids.length
    ? `\n  children: [\n${kids
        .map((k) => {
          const b = childBusiness(c, k.table);
          return `    { resource: ${lit(camel(b))}, label: ${lit(k.label)}, entity: ${pascal(b)}Entity, foreignKey: ${lit(k.foreignKey)} },`;
        })
        .join('\n')}\n  ],`
    : '';
  const api = [
    'page',
    'info',
    'add',
    'update',
    'delete',
    ...(c.options?.deleteMode === 'hard'
      ? []
      : ['recycle', 'restore', 'purge']),
    ...(c.options?.export ? ['export'] : []),
    ...(tree ? ['tree'] : []),
  ];
  const keyWords = c.fields
    .filter((f) => f.query === 'like')
    .map((f) => lit(f.name));
  const fieldEq = c.fields
    .filter((f) => f.query && f.query !== 'like')
    .map((f) => lit(f.name));
  return `// 由代码生成器生成（${c.module}.${c.business}）
import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { ${name}Entity } from '../../entity/${c.business}.entity.js';
${kidImports}
@CrudController({
  prefix: ${lit(c.permPrefix.replace(/:/g, '/'))},
  label: ${lit(c.label)},
  entity: ${name}Entity,
  api: [${api.map(lit).join(', ')}],
  delete: ${lit(c.options?.deleteMode ?? 'soft')},${c.options?.dataScope ? '\n  dataScope: true,' : ''}
  pageQuery: {
    keyWords: [${keyWords.join(', ')}],
    fieldEq: [${fieldEq.join(', ')}],
  },${kidOptions}${treeOption}
})
export class ${name}Controller extends BaseController<${name}Entity> {}
`;
}

function module_(c: CodegenConfig): string {
  const name = pascal(c.business);
  const kids = (c.template === 'master-detail' ? (c.children ?? []) : []).map(
    (k) => childBusiness(c, k.table),
  );
  return `// 由代码生成器生成（${c.module}.${c.business}）。在 AppModule 的 imports 里加上 ${name}Module
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ${name}Controller } from './controller/admin/${c.business}.controller.js';
import { ${name}Entity } from './entity/${c.business}.entity.js';
${kids.map((b) => `import { ${pascal(b)}Entity } from './entity/${b}.entity.js';\n`).join('')}
@Module({
  imports: [TypeOrmModule.forFeature([${[name, ...kids.map(pascal)].map((k) => `${k}Entity`).join(', ')}])],
  controllers: [${name}Controller],
})
export class ${name}Module {}
`;
}

function migration(
  c: Pick<CodegenConfig, 'module' | 'business' | 'table' | 'fields'>,
  stamp: number,
  foreignKey?: string,
  treeParent?: string,
): string {
  const name = `Create${pascal(c.table)}${stamp}`;
  const definition = JSON.stringify(
    tableDefinition(c, foreignKey, treeParent),
    null,
    2,
  );
  return `// 由代码生成器生成（${c.module}.${c.business}）。只生成，不会自动执行：确认后用迁移命令执行
import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';
export class ${name} implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.createTable(new Table(${definition}));
  }
  async down(q: QueryRunner): Promise<void> {
    await q.dropTable(${lit(c.table)});
  }
}
`;
}

/** 菜单和按钮权限的初始化数据（T10 的 seed 读取 src/modules/**\/*.menu.json） */
function menu(c: CodegenConfig): string {
  const actions = [
    'page',
    'info',
    'add',
    'update',
    'delete',
    ...(c.options?.deleteMode === 'hard'
      ? []
      : ['recycle', 'restore', 'purge']),
    ...(c.options?.export ? ['export'] : []),
  ];
  const titles: Record<string, string> = {
    page: '查看',
    info: '详情',
    add: '新增',
    update: '修改',
    delete: '删除',
    recycle: '回收站',
    restore: '恢复',
    purge: '彻底删除',
    export: '导出',
  };
  return (
    JSON.stringify(
      {
        parentMenuId: c.options?.parentMenuId ?? null,
        page: {
          title: c.label,
          path: `/${c.module}/${kebab(c.business)}`,
          // 组件键：前端导航白名单（navigationViews）按它找页面，和页面的 pageKey 一致
          component: c.permPrefix.replace(/:/g, '/'),
          permission: `${c.permPrefix}:page`,
        },
        buttons: actions
          .filter((a) => a !== 'page')
          .map((a) => ({
            title: titles[a],
            permission: `${c.permPrefix}:${a}`,
          })),
      },
      null,
      2,
    ) + '\n'
  );
}

/**
 * 渲染后端文件（T21 第二步）。路径只会落在白名单目录：src/modules/<module>/ 和 src/database/migrations/。
 * stamp 是迁移时间戳（第一次生成时定下，存在配置的指纹里，之后不变）。
 * 主子表：每个子表生成实体和迁移，控制器里配 children；
 * 树表：父级字段生成为可空 bigint（带索引），控制器配 tree 并开放 tree 接口，表单里父级字段用树形选择。
 */
const treeParentOf = (c: CodegenConfig) =>
  c.template === 'tree' ? c.tree?.parentField : undefined;

export function renderServer(c: CodegenConfig, stamp: number): GeneratedFile[] {
  const base = `src/modules/${c.module}`;
  const kids: GeneratedFile[] = [];
  if (c.template === 'master-detail')
    (c.children ?? []).forEach((k, i) => {
      const b = childBusiness(c, k.table);
      const cfg = {
        module: c.module,
        business: b,
        table: k.table,
        fields: k.fields,
      };
      kids.push(
        {
          project: 'server',
          path: `${base}/entity/${b}.entity.ts`,
          content: entity(cfg, k.foreignKey),
        },
        {
          project: 'server',
          path: `src/database/migrations/${stamp + i + 1}-Create${pascal(k.table)}.ts`,
          content: migration(cfg, stamp + i + 1, k.foreignKey),
        },
      );
    });
  return [
    {
      project: 'server',
      path: `${base}/entity/${c.business}.entity.ts`,
      content: entity(c, undefined, treeParentOf(c)),
    },
    {
      project: 'server',
      path: `${base}/controller/admin/${c.business}.controller.ts`,
      content: controller(c),
    },
    {
      project: 'server',
      path: `${base}/${c.business}.module.ts`,
      content: module_(c),
    },
    {
      project: 'server',
      path: `${base}/${c.business}.menu.json`,
      content: menu(c),
    },
    {
      project: 'server',
      path: `src/database/migrations/${stamp}-Create${pascal(c.table)}.ts`,
      content: migration(c, stamp, undefined, treeParentOf(c)),
    },
    ...kids,
  ];
}

export { camel, pascal };
