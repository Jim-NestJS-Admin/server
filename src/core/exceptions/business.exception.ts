import { HttpException, HttpStatus } from '@nestjs/common';
import { DEFAULT_MESSAGES, ErrorCode } from './error-code.js';

/**
 * 业务错误一律抛这个异常，不要返回错误对象（AGENTS 规则 5）。
 * 例：throw new BusinessException(ErrorCode.Conflict, '用户名已存在');
 */
export class BusinessException extends HttpException {
  constructor(
    readonly code: number,
    message?: string,
    status: number = HttpStatus.BAD_REQUEST,
    readonly details?: unknown,
  ) {
    super(message ?? DEFAULT_MESSAGES[code as ErrorCode] ?? '请求失败', status);
  }
}
