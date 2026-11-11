import { applyUtcSessions } from './utc-session.js';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigService } from '../config/app-config.service.js';
import { HealthService } from '../health/health.service.js';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from './naming.strategy.js';
import { applyQueryTimeout } from './query-timeout.js';

/**
 * 数据库连接（MySQL 8.4 + TypeORM）。实体由各模块用 TypeOrmModule.forFeature 注册，autoLoadEntities 自动收集。
 * 表结构用迁移管理（T10），只有测试环境允许 DB_SYNCHRONIZE 自动建表。
 * 导出接口文档时不连数据库（导出脚本设置 OPENAPI_EXPORT），生成文档不依赖本机有没有 MySQL。
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        type: 'mysql' as const,
        host: config.db.host,
        port: config.db.port,
        username: config.db.user,
        password: config.db.password,
        database: config.db.name,
        charset: 'utf8mb4_0900_ai_ci',
        timezone: 'Z',
        // bigint 一律按字符串返回，避免超过 JS 安全整数后丢精度
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: false,
        namingStrategy: new SnakeNamingStrategy(),
        autoLoadEntities: true,
        synchronize: config.db.synchronize,
        manualInitialization: config.openApiExport,
        logging: false,
      }),
    }),
  ],
})
export class DatabaseModule {
  constructor(
    health: HealthService,
    dataSource: DataSource,
    config: AppConfigService,
  ) {
    applyQueryTimeout(dataSource, config.db.queryTimeoutMs);
    applyUtcSessions(dataSource);
    health.register('database', async () => {
      await dataSource.query('SELECT 1');
    });
  }
}
