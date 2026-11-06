import {
  FieldPermStateDto,
  QueryConditionDto,
  QueryGroupDto,
} from '../crud/crud-query.dto.js';
import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';

/**
 * 接口文档。前端的接口代码、类型、权限码和枚举都从这里导出的 openapi/admin.json 生成（架构「工程目录结构」）。
 * 权限码、scope 放进文档扩展字段的逻辑在 T06 加入。
 */
export function buildOpenApiDocument(
  app: INestApplication,
  version: string,
): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('jim-nestjs-admin 接口')
    .setDescription(
      '后台、APP、网站、开放接口。统一响应格式：{ code, data, message }，code 为 1000 表示成功。',
    )
    .setVersion(version)
    .addBearerAuth()
    .build();
  // 只通过 $ref 引用的模型（高级查询递归分组、字段权限状态）要显式登记
  return SwaggerModule.createDocument(app, config, {
    extraModels: [QueryConditionDto, QueryGroupDto, FieldPermStateDto],
  });
}

export function setupSwagger(app: INestApplication, version: string): void {
  SwaggerModule.setup('docs', app, () => buildOpenApiDocument(app, version), {
    jsonDocumentUrl: 'docs/openapi.json',
  });
}

/** 键按字母排序后输出，保证同样的代码每次导出完全一样，方便看差异 */
export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}
