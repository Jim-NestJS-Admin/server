import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { BusinessException } from '../exceptions/business.exception.js';
import {
  codeFromStatus,
  DEFAULT_MESSAGES,
  ErrorCode,
} from '../exceptions/error-code.js';

/**
 * 全局异常过滤：所有错误都按 { code, data, message } 返回。
 * 未知异常只返回「服务器内部错误」，堆栈和原始信息只进日志，永远不出现在响应里。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof BusinessException) {
      res.status(exception.getStatus()).json({
        code: exception.code,
        data: exception.details ?? null,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = codeFromStatus(status);
      const body = exception.getResponse();
      // Nest 自带异常的 message 可能是英文或数组，统一换成中文默认文案；4xx 保留可读的单条中文说明。
      // 5xx 一律只返回公开文案，异常里的信息只进日志（业务上需要公开的提示请用 BusinessException）
      const raw =
        typeof body === 'object' && body !== null
          ? (body as { message?: unknown }).message
          : body;
      const message =
        status < 500 && typeof raw === 'string' && /[一-龥]/.test(raw)
          ? raw
          : DEFAULT_MESSAGES[code];
      if (status >= 500) this.logger.error(exception);
      res.status(status).json({ code, data: null, message });
      return;
    }

    this.logger.error(
      exception instanceof Error
        ? (exception.stack ?? exception.message)
        : String(exception),
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: ErrorCode.Internal,
      data: null,
      message: DEFAULT_MESSAGES[ErrorCode.Internal],
    });
  }
}
