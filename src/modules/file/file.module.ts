import { Module, type DynamicModule } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileAssetController } from './controller/admin/file-asset.controller.js';
import { FileController } from './controller/admin/file.controller.js';
import { FileAssetEntity } from './entity/file-asset.entity.js';
import { FileGuard } from './file.guard.js';
import {
  DenyFileAccess,
  FileAccess,
  FileCatalog,
  UnconfiguredFileCatalog,
} from './file.ports.js';
import {
  FILE_POLICY,
  validateFilePolicy,
  type FilePolicy,
} from './file.policy.js';
import { FileService } from './service/file.service.js';
import { FileAssetService } from './service/file-asset.service.js';
import { BlobStore } from './storage/blob-store.js';
import { SessionFileAccess } from './session-file-access.js';

export interface FileModuleOptions {
  store: BlobStore;
  policy: FilePolicy;
  /** 只能由 T05/T06 后台认证/权限实现提供，默认拒绝访问。 */
  access?: FileAccess | 'session';
  /** 必须接 core 的租户隔离和数据库事务，默认503，禁止内存替代。 */
  catalog?: FileCatalog | 'database';
}
/** 可装配存储适配器；实际应用显式选择session/database，独立使用仍默认拒绝。 */
@Module({})
export class FileModule {
  static register(options: FileModuleOptions): DynamicModule {
    const policy = validateFilePolicy(options.policy);
    const database = options.catalog === 'database';
    return {
      module: FileModule,
      global: true,
      imports: [
        ...(database ? [TypeOrmModule.forFeature([FileAssetEntity])] : []),
        MulterModule.register({
          limits: {
            files: 1,
            fileSize: policy.maxBytes,
            fields: 0,
            parts: 1,
            headerPairs: 32,
          },
        }),
      ],
      controllers: [FileController, ...(database ? [FileAssetController] : [])],
      providers: [
        ...(database ? [FileAssetService] : []),
        FileService,
        FileGuard,
        { provide: FILE_POLICY, useValue: policy },
        { provide: BlobStore, useValue: options.store },
        options.access === 'session'
          ? { provide: FileAccess, useClass: SessionFileAccess }
          : {
              provide: FileAccess,
              useValue: options.access ?? new DenyFileAccess(),
            },
        database
          ? { provide: FileCatalog, useExisting: FileAssetService }
          : {
              provide: FileCatalog,
              useValue: options.catalog ?? new UnconfiguredFileCatalog(),
            },
      ],
      exports: [FileService],
    };
  }
}
