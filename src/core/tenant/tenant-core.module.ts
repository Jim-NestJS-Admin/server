import {
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type Type,
} from '@nestjs/common';
import {
  LoggerPlatformAuditSink,
  PlatformAuditSink,
  PlatformContext,
} from './platform-context.js';
import { BuiltinTenantSource, TenantSource } from './tenant-source.js';

export interface TenantCoreModuleOptions {
  /** 租户目录的实现，租户模块（T31）提供；不传时只有平台和默认租户 */
  source?: Type<TenantSource>;
  /** 平台审计的落地方式；不传时只写结构化日志 */
  auditSink?: Type<PlatformAuditSink>;
  imports?: ModuleMetadata['imports'];
}

/**
 * 多租户（阶段 2，契约 tenant.md）：租户目录、平台受控入口、平台审计。
 * 在 AppModule 里 `TenantCoreModule.forRoot({ source, imports: [TenantModule] })`。
 */
@Module({})
export class TenantCoreModule {
  static forRoot(options: TenantCoreModuleOptions = {}): DynamicModule {
    return {
      module: TenantCoreModule,
      global: true,
      imports: [...(options.imports ?? [])],
      providers: [
        {
          provide: TenantSource,
          useClass: options.source ?? BuiltinTenantSource,
        },
        {
          provide: PlatformAuditSink,
          useClass: options.auditSink ?? LoggerPlatformAuditSink,
        },
        PlatformContext,
      ],
      exports: [TenantSource, PlatformAuditSink, PlatformContext],
    };
  }
}
