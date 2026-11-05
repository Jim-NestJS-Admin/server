import { HttpStatus } from '@nestjs/common';
import { QueryFailedError, type DataSource } from 'typeorm';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';
import type { FieldError } from '../validation.js';
import type { CrudResourceMeta } from './crud.types.js';

/** 字段错误：主子表保存时带上子表名和行标识（已有行 id、新增行 clientId，没有可用 clientId 时给 index） */
export interface CrudFieldError extends FieldError {
  resource?: string;
  id?: string;
  clientId?: string;
  index?: number;
}

/**
 * CRUD 的对外错误（T19 审查第 1 条、T03 补充验收）：
 * - 不存在和无权访问一律 404 / 4004，说明文字也一样，不能借此判断看不见的数据是否存在；
 * - 版本冲突 409 / 4009，只用于「数据已被他人修改」；
 * - 参数、唯一约束、引用等问题 400 / 4000，字段错误放在 data.errors。
 */
export const crudErrors = {
  notFound: () =>
    new BusinessException(
      ErrorCode.NotFound,
      '数据不存在或无权访问',
      HttpStatus.NOT_FOUND,
    ),
  versionConflict: () =>
    new BusinessException(
      ErrorCode.Conflict,
      '数据已被他人修改，请刷新后重试',
      HttpStatus.CONFLICT,
    ),
  badRequest: (message: string, errors?: CrudFieldError[]) =>
    new BusinessException(
      ErrorCode.BadRequest,
      message,
      HttpStatus.BAD_REQUEST,
      errors ? { errors } : undefined,
    ),
};

interface MysqlDriverError {
  code?: string;
  sqlMessage?: string;
}

const SYSTEM_COLUMNS = new Set(['tenantId', 'activeGuard', 'deletedAt']);

/** 把数据库报错翻译成对外错误；不认识的原样抛出，由全局异常过滤按 500 处理 */
export function translateDbError(
  err: unknown,
  meta: CrudResourceMeta,
  dataSource: DataSource,
): unknown {
  if (!(err instanceof QueryFailedError)) return err;
  const driver = (err as QueryFailedError & { driverError?: MysqlDriverError })
    .driverError;
  switch (driver?.code) {
    case 'ER_DUP_ENTRY': {
      const key = /for key '(?:[^'.]*\.)?([^']+)'/.exec(
        driver.sqlMessage ?? '',
      )?.[1];
      const em = dataSource.getMetadata(meta.entity);
      const index =
        em.indices.find((i) => i.name === key) ??
        em.uniques.find((u) => u.name === key);
      const props = (index?.columns ?? [])
        .map((c) => c.propertyName)
        .filter((p) => !SYSTEM_COLUMNS.has(p));
      const labels = props.map(
        (p) => meta.fields.find((f) => f.property === p)?.label ?? p,
      );
      const message = labels.length
        ? `${labels.join('、')}已存在`
        : '数据重复，和已有数据冲突';
      return crudErrors.badRequest(
        message,
        props.map((field) => ({ field, messages: [message] })),
      );
    }
    case 'ER_ROW_IS_REFERENCED_2':
    case 'ER_ROW_IS_REFERENCED':
      return crudErrors.badRequest('数据已被其他数据引用，不能删除');
    case 'ER_NO_REFERENCED_ROW_2':
    case 'ER_NO_REFERENCED_ROW':
      return crudErrors.badRequest('关联的数据不存在');
    default:
      return err;
  }
}
