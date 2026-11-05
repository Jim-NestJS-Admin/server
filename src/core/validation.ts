import {
  HttpStatus,
  ValidationPipe,
  type ValidationError,
} from '@nestjs/common';
import { BusinessException } from './exceptions/business.exception.js';
import { ErrorCode } from './exceptions/error-code.js';

export interface FieldError {
  field: string;
  messages: string[];
}

function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = e.constraints
      ? [{ field, messages: Object.values(e.constraints) }]
      : [];
    return [...own, ...flatten(e.children ?? [], field)];
  });
}

/** 全局参数校验：去掉 DTO 没声明的字段并报错；错误按字段列在 data.errors 里 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new BusinessException(
        ErrorCode.BadRequest,
        '请求参数有误',
        HttpStatus.BAD_REQUEST,
        {
          errors: flatten(errors),
        },
      ),
  });
}
