import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';

export const QUERY_OPS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'contains',
  'startsWith',
  'between',
  'isNull',
  'notNull',
] as const;

/** 高级查询的一个条件（契约 query.md） */
export class QueryConditionDto {
  @ApiProperty({ description: '可筛选字段（页面描述 query[].field）' })
  field: string;
  @ApiProperty({ enum: QUERY_OPS }) op: (typeof QUERY_OPS)[number];
  @ApiPropertyOptional({
    description:
      '值：eq…lte 是简单值；in / notIn 是数组；between 是 [下限, 上限]；isNull / notNull 不要',
  })
  value?: unknown;
}

/** 高级查询分组：最多 3 层、共 20 个条件 */
export class QueryGroupDto {
  @ApiProperty({ enum: ['and', 'or'] }) op: 'and' | 'or';
  @ApiProperty({
    type: 'array',
    items: {
      oneOf: [
        { $ref: getSchemaPath('QueryConditionDto') },
        { $ref: getSchemaPath('QueryGroupDto') },
      ],
    },
  })
  items: (QueryConditionDto | QueryGroupDto)[];
}

/** 页面描述里一个字段在本页面的最宽字段权限状态 */
export class FieldPermStateDto {
  @ApiProperty({ enum: ['editable', 'readonly', 'masked', 'hidden'] })
  state: string;
  @ApiProperty({
    enum: ['phone', 'email', 'idcard', 'last4', 'all'],
    nullable: true,
    type: String,
  })
  mask: string | null;
}
