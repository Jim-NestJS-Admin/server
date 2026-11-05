import { Module, type DynamicModule } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { FileController } from './controller/admin/file.controller.js';
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
import { BlobStore } from './storage/blob-store.js';

export interface FileModuleOptions {
  store: BlobStore;
  policy: FilePolicy;
  /** 只能由 T05/T06 后台认证/权限实现提供，默认拒绝访问。 */
  access?: FileAccess;
  /** 必须接 core 的租户隔离和数据库事务，默认503，禁止内存替代。 */
  catalog?: FileCatalog;
}
/** 独立可装配模块，当前未注册到 AppModule；正式持久化/认证接入后再统一导出正式接口。 */
@Module({})
export class FileModule {
  static register(options: FileModuleOptions): DynamicModule {
    const policy = validateFilePolicy(options.policy);
    return {
      module: FileModule,
      imports: [
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
      controllers: [FileController],
      providers: [
        FileService,
        FileGuard,
        { provide: FILE_POLICY, useValue: policy },
        { provide: BlobStore, useValue: options.store },
        {
          provide: FileAccess,
          useValue: options.access ?? new DenyFileAccess(),
        },
        {
          provide: FileCatalog,
          useValue: options.catalog ?? new UnconfiguredFileCatalog(),
        },
      ],
      exports: [FileService],
    };
  }
}
