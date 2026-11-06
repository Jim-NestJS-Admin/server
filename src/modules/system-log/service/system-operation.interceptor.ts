import {
  Injectable,
  HttpException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tap } from 'rxjs';
import type { Request } from 'express';
import {
  PERMS_KEY,
  type PermMeta,
} from '../../../core/permission/perms.decorator.js';
import { SystemOperationRecorder } from './system-audit.service.js';

/** 只记动作、结果和耗时，不捕获请求体、查询参数或认证头。 */
@Injectable()
export class SystemOperationInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly recorder: SystemOperationRecorder,
  ) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const permission = this.reflector.get<PermMeta | undefined>(
      PERMS_KEY,
      context.getHandler(),
    );
    if (!permission || /:(page|info|read)$/.test(permission.code))
      return next.handle();
    const request = context
      .switchToHttp()
      .getRequest<Request & { id?: string }>();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method))
      return next.handle();
    const started = Date.now();
    return next.handle().pipe(
      tap({
        next: () => {
          void this.recorder.record(
            permission.code,
            request.method,
            context.switchToHttp().getResponse<{ statusCode: number }>()
              .statusCode,
            Date.now() - started,
            request.id,
          );
        },
        error: (error: unknown) => {
          void this.recorder.record(
            permission.code,
            request.method,
            error instanceof HttpException ? error.getStatus() : 500,
            Date.now() - started,
            request.id,
          );
        },
      }),
    );
  }
}
