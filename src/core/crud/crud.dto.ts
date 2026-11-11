import { applyDecimalInputs } from './decimal-input.js';
import type { Type } from '@nestjs/common';
import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
  PartialType,
  PickType,
} from '@nestjs/swagger';
import { SYSTEM_FIELDS } from './base.entity.js';
import { QueryGroupDto } from './crud-query.dto.js';
import { Type as TransformType } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { CrudResourceMeta } from './crud.types.js';

/** 编号：bigint，按字符串传 */
export const ID_PATTERN = /^[1-9]\d{0,19}$/;
const ID_MESSAGE = '编号格式不正确';

/** 批量操作一次最多的行数 */
export const MAX_BATCH = 500;

type PropDecorator = (target: object, key: string) => void;

function named<T extends Type>(cls: T, name: string): T {
  Object.defineProperty(cls, 'name', { value: name });
  return cls;
}

function prop(
  cls: Type,
  key: string,
  type: unknown,
  decorators: PropDecorator[],
): void {
  Reflect.defineMetadata('design:type', type, cls.prototype, key);
  for (const d of decorators) d(cls.prototype, key);
}

/** 一个资源的全部请求和响应 DTO，接口文档和参数校验都用它们 */
export interface CrudDtos {
  PageBody: Type;
  ExportBody: Type;
  InfoBody: Type;
  AddBody: Type;
  UpdateBody: Type;
  DeleteBody: Type;
  Row: Type;
  /** 详情、新增、修改的返回：有子表时带 children */
  Detail: Type;
  PageResult: Type;
  DeleteResult: Type;
  RecyclePageBody: Type;
  RecyclePageResult: Type;
  /** 树形列表：平铺的全部可见节点 */
  TreeResult: Type;
  RecycleActionBody: Type;
}

/**
 * 按资源定义生成 DTO。可写字段从实体上 PickType 出来，连同实体上的 class-validator 校验一起带过来；
 * 请求里出现 DTO 没有的字段时，全局校验管道会直接报错（forbidNonWhitelisted）。
 */
export function buildCrudDtos(meta: CrudResourceMeta): CrudDtos {
  const n = meta.name;
  const entity = meta.entity as Type;

  const AddData = named(
    PickType(entity, meta.addable as never[]) as Type,
    `${n}AddData`,
  );
  const UpdateData = named(
    PartialType(PickType(entity, meta.updatable as never[])) as Type,
    `${n}UpdateData`,
  );
  const Eq = named(
    PartialType(PickType(entity, meta.fieldEq as never[])) as Type,
    `${n}PageEq`,
  );

  // ---------- 子表 ----------
  // 请求体里的 children 只用于接口文档；逐行校验由 BaseService 做，这样错误能按 resource + id / clientId 定位到行
  const AddChildren = named(class {}, `${n}AddChildren`);
  const UpdateChildren = named(class {}, `${n}UpdateChildren`);
  const DetailChildren = named(class {}, `${n}DetailChildren`);
  applyDecimalInputs(AddData, entity, meta.addable, meta.fields);
  applyDecimalInputs(UpdateData, entity, meta.updatable, meta.fields);
  applyDecimalInputs(Eq, entity, meta.fieldEq, meta.fields);

  for (const c of meta.children) {
    const ce = c.entity as Type;
    const AddRow = named(
      PickType(ce, c.addable as never[]) as Type,
      `${c.name}AddRow`,
    );
    prop(AddRow, 'clientId', String, [
      ApiProperty({
        description: '前端给新增行的临时标识，本次请求内唯一，只用来定位错误',
        maxLength: 64,
      }),
      IsString({ message: 'clientId 必须是字符串' }),
      IsNotEmpty({ message: '新增行必须带 clientId' }),
      MaxLength(64),
    ]);
    const UpdateRow = named(
      PartialType(PickType(ce, c.updatable as never[])) as Type,
      `${c.name}UpdateRow`,
    );
    prop(UpdateRow, 'id', String, [
      ApiProperty({ type: String, description: '已有行的编号' }),
      Matches(ID_PATTERN, { message: ID_MESSAGE }),
    ]);
    applyDecimalInputs(AddRow, ce, c.addable, c.fields);
    applyDecimalInputs(UpdateRow, ce, c.updatable, c.fields);
    c.rowDtos = { AddRow, UpdateRow };

    const AddChange = named(class {}, `${c.name}AddChange`);
    prop(AddChange, 'added', Array, [
      ApiPropertyOptional({ type: [AddRow], maxItems: c.max }),
    ]);
    const Change = named(class {}, `${c.name}Change`);
    prop(Change, 'added', Array, [
      ApiPropertyOptional({ type: [AddRow], maxItems: MAX_BATCH }),
    ]);
    prop(Change, 'updated', Array, [
      ApiPropertyOptional({
        type: [UpdateRow],
        maxItems: MAX_BATCH,
        description: '只传要改的字段',
      }),
    ]);
    prop(Change, 'deleted', Array, [
      ApiPropertyOptional({
        type: [String],
        maxItems: MAX_BATCH,
        description: '要删除的行编号；没列出的行保持不动',
      }),
    ]);
    prop(AddChildren, c.resource, Object, [
      ApiPropertyOptional({ type: AddChange, description: c.label }),
    ]);
    prop(UpdateChildren, c.resource, Object, [
      ApiPropertyOptional({ type: Change, description: c.label }),
    ]);

    const ChildRow = named(
      PickType(ce, c.readable as never[]) as Type,
      `${c.name}Row`,
    );
    prop(DetailChildren, c.resource, Array, [
      ApiProperty({ type: [ChildRow], description: c.label }),
    ]);
  }
  const hasChildren = meta.children.length > 0;
  const childrenProp = (cls: Type, type: Type, desc: string) =>
    prop(cls, 'children', Object, [
      ApiPropertyOptional({ type, description: desc }),
      IsOptional(),
      IsObject({ message: 'children 必须是对象' }),
    ]);

  const SortItem = named(class {}, `${n}PageSort`);
  prop(SortItem, 'field', String, [
    ApiProperty({ enum: meta.sortable, description: '排序字段' }),
    IsIn(meta.sortable, { message: '不能按这个字段排序' }),
  ]);
  prop(SortItem, 'order', String, [
    ApiProperty({ enum: ['asc', 'desc'] }),
    IsIn(['asc', 'desc']),
  ]);

  const PageBody = named(class {}, `${n}PageBody`);
  prop(PageBody, 'page', Number, [
    ApiPropertyOptional({ minimum: 1, default: 1 }),
    IsOptional(),
    IsInt(),
    Min(1),
  ]);
  prop(PageBody, 'size', Number, [
    ApiPropertyOptional({ minimum: 1, maximum: meta.maxSize, default: 20 }),
    IsOptional(),
    IsInt(),
    Min(1),
    Max(meta.maxSize, { message: `每页最多 ${meta.maxSize} 条` }),
  ]);
  prop(PageBody, 'keyword', String, [
    ApiPropertyOptional({
      description: meta.keyWords.length
        ? `搜索框，模糊匹配：${meta.keyWords.join('、')}`
        : '这个资源没有配置搜索字段，传了也不生效',
      maxLength: 100,
    }),
    IsOptional(),
    IsString(),
    MaxLength(100),
  ]);
  prop(PageBody, 'sort', Array, [
    ApiPropertyOptional({ type: [SortItem], maxItems: 5 }),
    IsOptional(),
    IsArray(),
    ArrayMaxSize(5),
    ValidateNested({ each: true }),
    TransformType(() => SortItem),
  ]);
  prop(PageBody, 'eq', Object, [
    ApiPropertyOptional({ type: Eq, description: '按等于筛选' }),
    IsOptional(),
    IsObject(),
    ValidateNested(),
    TransformType(() => Eq),
  ]);

  prop(PageBody, 'where', Object, [
    ApiPropertyOptional({
      type: QueryGroupDto,
      description: '高级查询：最多 3 层、20 个条件（契约 query.md）',
    }),
    IsOptional(),
    IsObject(),
  ]);

  const ExportBody = named(class extends PageBody {}, `${n}ExportBody`);
  prop(ExportBody, 'timeZone', String, [
    ApiPropertyOptional({
      description: '浏览器 IANA 时区；省略时使用服务器本地时区',
      example: 'Asia/Shanghai',
      maxLength: 100,
    }),
    IsOptional(),
    IsString(),
    MaxLength(100),
  ]);
  prop(ExportBody, 'format', String, [
    ApiPropertyOptional({ enum: ['csv', 'xlsx'], default: 'csv' }),
    IsOptional(),
    IsIn(['csv', 'xlsx']),
  ]);
  prop(ExportBody, 'columns', Array, [
    ApiPropertyOptional({
      type: [String],
      description: '当前可见列，按传入顺序导出；仍按服务端字段权限裁剪',
      maxItems: 200,
    }),
    IsOptional(),
    IsArray(),
    ArrayMaxSize(200),
    IsString({ each: true }),
  ]);

  const InfoBody = named(class {}, `${n}InfoBody`);
  prop(InfoBody, 'id', String, [
    ApiProperty({ type: String, example: '1' }),
    Matches(ID_PATTERN, { message: ID_MESSAGE }),
  ]);

  const AddBody = named(class {}, `${n}AddBody`);
  prop(AddBody, 'data', Object, [
    ApiProperty({ type: AddData }),
    IsObject(),
    ValidateNested(),
    TransformType(() => AddData),
  ]);

  if (hasChildren)
    childrenProp(AddBody, AddChildren, '子表：每个子表只有新增的行');

  const UpdateBody = named(class {}, `${n}UpdateBody`);
  prop(UpdateBody, 'id', String, [
    ApiProperty({ type: String, example: '1' }),
    Matches(ID_PATTERN, { message: ID_MESSAGE }),
  ]);
  prop(UpdateBody, 'version', Number, [
    ApiProperty({ description: '读到的版本号，原样带回', minimum: 1 }),
    IsInt(),
    Min(1),
  ]);
  prop(UpdateBody, 'data', Object, [
    ApiProperty({ type: UpdateData, description: '只传要改的字段' }),
    IsObject(),
    ValidateNested(),
    TransformType(() => UpdateData),
  ]);

  if (hasChildren)
    childrenProp(
      UpdateBody,
      UpdateChildren,
      '子表：每个子表分别提交新增、修改、删除三组；没提交的行保持不动',
    );

  const DeleteBody = named(class {}, `${n}DeleteBody`);
  prop(DeleteBody, 'ids', Array, [
    ApiProperty({ type: [String], minItems: 1, maxItems: MAX_BATCH }),
    IsArray(),
    ArrayMinSize(1),
    ArrayMaxSize(MAX_BATCH),
    ArrayUnique(),
    Matches(ID_PATTERN, { each: true, message: ID_MESSAGE }),
  ]);

  // 响应：一行只含资源定义里的可读字段，和 BaseService.toRow 的输出一致。
  // 业务字段可能因字段权限被隐藏（不返回），所以是可选的；_fieldState 列出这一行不可编辑的字段
  const exempt = new Set<string>([...SYSTEM_FIELDS, 'version']);
  const fixed = meta.readable.filter((f) => exempt.has(f));
  const business = meta.readable.filter((f) => !exempt.has(f));
  const rowType = () => {
    const t = IntersectionType(
      PickType(entity, fixed as never[]),
      PartialType(PickType(entity, business as never[])),
    ) as Type;
    prop(t, '_fieldState', Object, [
      ApiProperty({
        required: false,
        description:
          '这一行上不是「可编辑」的字段：readonly 只读、masked 值已打码、hidden 不返回（契约 field-perm.md 3.1）',
        type: Object,
        additionalProperties: {
          type: 'string',
          enum: ['readonly', 'masked', 'hidden'],
        },
      }),
    ]);
    prop(t, '_display', Object, [
      ApiProperty({
        required: false,
        description:
          '编号字段的显示名：createdBy / updatedBy 是用户名称，orgId 是组织名称；查不到的不返回',
        type: Object,
        additionalProperties: { type: 'string' },
      }),
    ]);
    return t;
  };
  const Row = named(rowType(), `${n}Row`);
  let Detail = Row;
  if (hasChildren) {
    Detail = named(rowType(), `${n}Detail`);
    prop(Detail, 'children', Object, [ApiProperty({ type: DetailChildren })]);
  }
  const PageResult = named(class {}, `${n}PageResult`);
  prop(PageResult, 'list', Array, [ApiProperty({ type: [Row] })]);
  prop(PageResult, 'total', Number, [ApiProperty()]);
  prop(PageResult, 'page', Number, [ApiProperty()]);
  prop(PageResult, 'size', Number, [ApiProperty()]);
  const RecyclePageBody = named(class {}, `${n}RecyclePageBody`);
  prop(RecyclePageBody, 'page', Number, [
    ApiPropertyOptional({ minimum: 1, default: 1 }),
    IsOptional(),
    IsInt(),
    Min(1),
  ]);
  prop(RecyclePageBody, 'size', Number, [
    ApiPropertyOptional({ minimum: 1, maximum: meta.maxSize, default: 20 }),
    IsOptional(),
    IsInt(),
    Min(1),
    Max(meta.maxSize, { message: `每页最多 ${meta.maxSize} 条` }),
  ]);
  prop(RecyclePageBody, 'keyword', String, [
    ApiPropertyOptional({ maxLength: 100 }),
    IsOptional(),
    IsString(),
    MaxLength(100),
  ]);
  const RecycleRow = named(
    PickType(entity, meta.readable as never[]) as Type,
    `${n}RecycleRow`,
  );
  prop(RecycleRow, 'deletedAt', String, [
    ApiProperty({ type: String, format: 'date-time', description: '删除时间' }),
  ]);
  const RecyclePageResult = named(class {}, `${n}RecyclePageResult`);
  prop(RecyclePageResult, 'list', Array, [ApiProperty({ type: [RecycleRow] })]);
  prop(RecyclePageResult, 'total', Number, [ApiProperty()]);
  prop(RecyclePageResult, 'page', Number, [ApiProperty()]);
  prop(RecyclePageResult, 'size', Number, [ApiProperty()]);

  // 恢复、彻底删除：每行带上回收站里读到的版本号
  const RecycleItem = named(class {}, `${n}RecycleItem`);
  prop(RecycleItem, 'id', String, [
    ApiProperty({ type: String, example: '1' }),
    Matches(ID_PATTERN, { message: ID_MESSAGE }),
  ]);
  prop(RecycleItem, 'version', Number, [
    ApiProperty({
      description: '回收站列表里读到的版本号，原样带回',
      minimum: 1,
    }),
    IsInt(),
    Min(1),
  ]);
  const RecycleActionBody = named(class {}, `${n}RecycleActionBody`);
  prop(RecycleActionBody, 'items', Array, [
    ApiProperty({ type: [RecycleItem], minItems: 1, maxItems: MAX_BATCH }),
    IsArray(),
    ArrayMinSize(1),
    ArrayMaxSize(MAX_BATCH),
    ValidateNested({ each: true }),
    TransformType(() => RecycleItem),
  ]);

  const TreeResult = named(class {}, `${n}TreeResult`);
  prop(TreeResult, 'list', Array, [
    ApiProperty({
      type: [Row],
      description:
        '全部可见节点（平铺），前端按页面描述 tree.parentField 组树；父节点不在列表里的当作根节点',
    }),
  ]);

  const DeleteResult = named(class {}, `${n}DeleteResult`);
  prop(DeleteResult, 'count', Number, [
    ApiProperty({ description: '处理的行数' }),
  ]);

  return {
    PageBody,
    ExportBody,
    InfoBody,
    AddBody,
    UpdateBody,
    DeleteBody,
    Row,
    Detail,
    PageResult,
    DeleteResult,
    RecyclePageBody,
    RecyclePageResult,
    RecycleActionBody,
    TreeResult,
  };
}
