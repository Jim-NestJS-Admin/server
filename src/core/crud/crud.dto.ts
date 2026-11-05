import type { Type } from '@nestjs/common';
import {
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
  PickType,
} from '@nestjs/swagger';
import { Type as TransformType } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
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
  InfoBody: Type;
  AddBody: Type;
  UpdateBody: Type;
  DeleteBody: Type;
  Row: Type;
  PageResult: Type;
  DeleteResult: Type;
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

  const DeleteBody = named(class {}, `${n}DeleteBody`);
  prop(DeleteBody, 'ids', Array, [
    ApiProperty({ type: [String], minItems: 1, maxItems: MAX_BATCH }),
    IsArray(),
    ArrayMinSize(1),
    ArrayMaxSize(MAX_BATCH),
    ArrayUnique(),
    Matches(ID_PATTERN, { each: true, message: ID_MESSAGE }),
  ]);

  // 响应：一行数据就是实体上带接口文档说明的字段（内部字段已隐藏）
  const Row = named(class extends (entity as Type<object>) {}, `${n}Row`);
  const PageResult = named(class {}, `${n}PageResult`);
  prop(PageResult, 'list', Array, [ApiProperty({ type: [Row] })]);
  prop(PageResult, 'total', Number, [ApiProperty()]);
  prop(PageResult, 'page', Number, [ApiProperty()]);
  prop(PageResult, 'size', Number, [ApiProperty()]);
  const DeleteResult = named(class {}, `${n}DeleteResult`);
  prop(DeleteResult, 'count', Number, [
    ApiProperty({ description: '删除的行数' }),
  ]);

  return {
    PageBody,
    InfoBody,
    AddBody,
    UpdateBody,
    DeleteBody,
    Row,
    PageResult,
    DeleteResult,
  };
}
