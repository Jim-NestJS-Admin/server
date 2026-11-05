import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigService } from './config/app-config.service.js';
import { validateEnv } from './config/env.validation.js';
import { resolveRequestId, type RequestWithId } from './context/request-id.js';
import { AllExceptionsFilter } from './filters/all-exceptions.filter.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { ResponseInterceptor } from './interceptors/response.interceptor.js';
import { buildLoggerOptions } from './logger/logger.options.js';
import { CrudModule } from './crud/crud.module.js';
import { DatabaseModule } from './database/database.module.js';

/** core 框架层：配置、日志、请求上下文、统一响应、异常处理、健康检查、数据库、通用 CRUD。业务模块不写在这里 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req) => resolveRequestId(req as RequestWithId),
      },
    }),
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        buildLoggerOptions({
          level: config.logLevel,
          pretty: config.nodeEnv === 'development',
        }),
    }),
    DatabaseModule,
    CrudModule,
  ],
  controllers: [HealthController],
  providers: [
    AppConfigService,
    HealthService,
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [AppConfigService, HealthService],
})
export class CoreModule {}
