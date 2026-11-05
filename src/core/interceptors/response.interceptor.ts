import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import { RAW_RESPONSE } from '../decorators/raw-response.decorator.js';
import { ErrorCode } from '../exceptions/error-code.js';

export interface ApiResponse<T> {
  code: number;
  data: T;
  message: string;
}

/** 成功响应统一包成 { code: 1000, data, message: 'ok' }。字段权限的过滤和脱敏在 T16 接到这里 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T> | T
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T> | T> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw || context.getType() !== 'http') return next.handle();
    return next.handle().pipe(
      map((data) => ({
        code: ErrorCode.Ok,
        data: (data ?? null) as T,
        message: 'ok',
      })),
    );
  }
}
