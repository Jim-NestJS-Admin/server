import { applyDecorators, type Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { ErrorCode } from '../exceptions/error-code.js';

/** 字段错误：主子表保存时用 resource + id 定位已有行，resource + clientId 定位新增行 */
export class ApiFieldError {
  @ApiProperty({ example: 'username' }) field: string;
  @ApiProperty({ type: [String] }) messages: string[];
  @ApiPropertyOptional({ description: '子表资源名（主子表保存时）' })
  resource?: string;
  @ApiPropertyOptional({ description: '已有子行的编号' }) id?: string;
  @ApiPropertyOptional({ description: '新增子行的客户端标识' })
  clientId?: string;
}

export class ApiErrorData {
  @ApiPropertyOptional({ type: [ApiFieldError] }) errors?: ApiFieldError[];
}

export class ApiErrorBody {
  @ApiProperty({ description: '业务码，非 1000 都是失败', example: 4000 })
  code: number;
  @ApiProperty({ type: ApiErrorData, nullable: true })
  data: ApiErrorData | null;
  @ApiProperty({ example: '请求参数有误' }) message: string;
}

/** 成功响应：{ code: 1000, data, message: 'ok' } */
export function ApiResult(model?: Type): MethodDecorator {
  const data = model
    ? { $ref: getSchemaPath(model) }
    : { type: 'object', nullable: true };
  return applyDecorators(
    ...(model ? [ApiExtraModels(model)] : []),
    ApiOkResponse({
      schema: {
        type: 'object',
        required: ['code', 'data', 'message'],
        properties: {
          code: { type: 'integer', enum: [ErrorCode.Ok] },
          data,
          message: { type: 'string', example: 'ok' },
        },
      },
    }),
  );
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: '4000：参数有误、唯一冲突等，字段错误在 data.errors',
  404: '4004：数据不存在或无权访问',
  409: '4009：数据已被他人修改，请刷新后重试',
};

/** 失败响应：真实 HTTP 状态 + 数字业务码 */
export function ApiErrors(...statuses: (400 | 404 | 409)[]): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(ApiErrorBody, ApiErrorData, ApiFieldError),
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: ERROR_DESCRIPTIONS[status],
        schema: { $ref: getSchemaPath(ApiErrorBody) },
      }),
    ),
  );
}
