import {
  mkdtemp,
  rm,
  symlink,
  unlink,
  mkdir,
  readFile,
} from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { S3Client } from '@aws-sdk/client-s3';
import type OSS from 'ali-oss';
import request from 'supertest';
import { FileModule } from './file.module.js';
import {
  FileCatalog,
  FileMetadataWriteFailure,
  type FilePrincipal,
  type StoredFile,
} from './file.ports.js';
import { inspectFile, validateFilePolicy } from './file.policy.js';
import {
  assertBlobKey,
  boundedBuffer,
  type BlobStore,
} from './storage/blob-store.js';
import { LocalBlobStore } from './storage/local.store.js';
import { OssBlobStore, S3BlobStore } from './storage/cloud.store.js';
import { AllExceptionsFilter } from '../../core/filters/all-exceptions.filter.js';
import { ResponseInterceptor } from '../../core/interceptors/response.interceptor.js';
import { createValidationPipe } from '../../core/validation.js';
import { buildOpenApiDocument } from '../../core/swagger/swagger.js';
import { Global, Module } from '@nestjs/common';
import { IdempotencyRunner } from '../../core/security/idempotency.interceptor.js';
import type { IdempotencyLedger } from '../../core/security/idempotency.ledger.js';
import type { RedisService } from '../../core/redis/redis.service.js';
import type { RequestContext } from '../../core/tenant/request-context.js';

/**
 * 独立文件模块测试不装 Core/Crud：用真实的 IdempotencyRunner，配内存版 Redis 和账本替身，
 * 上传幂等的行为（文件内容进摘要、同键重放、换文件 409）照样能断言。
 */
const idemRedis = new Map<string, string>();
const idemRunner = new IdempotencyRunner(
  {
    tenantKey: (...p: string[]) => p.join(':'),
    call: async (fn: (r: unknown) => unknown) =>
      fn({
        set: (k: string, v: string, ...a: unknown[]) => {
          if (a.includes('NX') && idemRedis.has(k)) return null;
          idemRedis.set(k, v);
          return 'OK';
        },
        get: (k: string) => idemRedis.get(k) ?? null,
        del: (k: string) => idemRedis.delete(k),
      }),
  } as unknown as RedisService,
  {
    current: () => ({ tenantId: '1', orgId: '1', userId: '1' }),
  } as unknown as RequestContext,
  {
    find: async () => null,
    begin: () => undefined,
    complete: async () => undefined,
    skip: () => undefined,
    pending: () => undefined,
  } as unknown as IdempotencyLedger,
);
@Global()
@Module({
  providers: [{ provide: IdempotencyRunner, useValue: idemRunner }],
  exports: [IdempotencyRunner],
})
class TestIdempotencyModule {}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
  'base64',
);
const policy = validateFilePolicy({
  maxBytes: 512,
  mimeTypes: ['image/png', 'application/pdf'],
});
const key = (tenant = '1') => `tenants/${tenant}/${randomUUID()}.png`;
const roots: string[] = [];
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'jim-t09-'));
  roots.push(root);
  return root;
}
afterAll(async () => {
  for (const root of roots) {
    // 仅删除本测试 mkdtemp 创建的目录，核对绝对路径后再递归，不能删除任意计算路径。
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'jim-t09-'))
      throw Error('测试清理目录越界');
    await rm(root, { recursive: true, force: true });
  }
});
describe('上传内容策略', () => {
  it('以内容判断，识别 PNG，不接受伪造 MIME 的脚本和未知内容', async () => {
    expect(await inspectFile(png, policy)).toMatchObject({
      mime: 'image/png',
      ext: 'png',
    });
    await expect(
      inspectFile(Buffer.from('<script>alert(1)</script>'), policy),
    ).rejects.toMatchObject({ code: 4000 });
  });
  it('空内容和截断文件拒绝，读前限制大小，策略不能开放可执行类型', async () => {
    await expect(inspectFile(Buffer.alloc(0), policy)).rejects.toMatchObject({
      code: 4000,
    });
    await expect(inspectFile(Buffer.alloc(513), policy)).rejects.toMatchObject({
      code: 4013,
    });
    await expect(inspectFile(png.subarray(0, 3), policy)).rejects.toMatchObject(
      { code: 4000 },
    );
    expect(() =>
      validateFilePolicy({ maxBytes: 1, mimeTypes: ['text/html'] }),
    ).toThrow();
    expect(() =>
      validateFilePolicy({ maxBytes: Infinity, mimeTypes: ['image/png'] }),
    ).toThrow();
  });
  it.each([
    '../x.png',
    '/tmp/x.png',
    'tenants/1/../../x.png',
    'https://example.com/a.png',
    'tenants/01/a.png',
    'tenants/1/../../../CON',
  ])('存储拒绝任意路径 %s', (value) => {
    expect(() => assertBlobKey(value)).toThrow();
  });
  it('下载流也有上限并在异常时关闭', async () => {
    const stream = Readable.from([Buffer.alloc(300), Buffer.alloc(300)]);
    await expect(boundedBuffer(stream, 512)).rejects.toMatchObject({
      code: 4013,
    });
    expect(stream.destroyed).toBe(true);
  });
});
describe('本地私有存储', () => {
  it('系统对象名读写，不能覆盖，跨根路径拒绝', async () => {
    const root = await temp(),
      store = new LocalBlobStore(root),
      name = key();
    await store.put(name, png);
    expect(await store.get(name, 512)).toEqual(png);
    await expect(store.put(name, Buffer.from('覆盖'))).rejects.toThrow();
    await expect(store.get(name, 10)).rejects.toMatchObject({ code: 4013 });
    await expect(store.put('../outside', png)).rejects.toThrow();
    await store.discard(name);
    await expect(store.get(name, 512)).rejects.toThrow();
  });
  it('已存在的 junction/symlink 目录不能导致越界创建或读写', async () => {
    const root = await temp(),
      outside = await temp();
    await mkdir(join(root, 'tenants'));
    const link = join(root, 'tenants', '1');
    await symlink(
      outside,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    try {
      await expect(new LocalBlobStore(root).put(key(), png)).rejects.toThrow(
        /符号链接/,
      );
    } finally {
      await unlink(link);
    }
    expect(
      await readFile(join(outside, '不存在')).catch(
        (error: NodeJS.ErrnoException) => error.code,
      ),
    ).toBe('ENOENT');
  });
});
describe('云存储 SDK 适配，不访问真实云', () => {
  it('S3 使用限定桶和生成对象名，禁止覆盖，下载有上限', async () => {
    const calls: { input: object }[] = [];
    const client = {
      send: vi.fn(async (command: { input: object }) => {
        calls.push(command);
        return { Body: Readable.from([png]) };
      }),
    } as unknown as S3Client;
    const store = new S3BlobStore(client, 'private-test'),
      name = key();
    await store.put(name, png, 'image/png');
    expect(calls[0].input).toMatchObject({
      Bucket: 'private-test',
      Key: name,
      IfNoneMatch: '*',
      ContentDisposition: 'attachment',
    });
    expect(await store.get(name, 512)).toEqual(png);
    await store.discard(name);
    const before = calls.length;
    await expect(store.get('../x', 512)).rejects.toThrow();
    expect(calls).toHaveLength(before);
  });
  it('OSS 强制对象私有与禁止覆盖，不返回 SDK 公网地址', async () => {
    const put = vi.fn(),
      remove = vi.fn();
    const client = {
      put,
      delete: remove,
      getStream: async () => ({ stream: Readable.from([png]) }),
    } as unknown as OSS;
    const store = new OssBlobStore(client),
      name = key();
    await store.put(name, png, 'image/png');
    expect(put.mock.calls[0][2].headers).toMatchObject({
      'x-oss-object-acl': 'private',
      'x-oss-forbid-overwrite': 'true',
    });
    expect(await store.get(name, 512)).toEqual(png);
    await store.discard(name);
    expect(remove).toHaveBeenCalledWith(name);
  });
});
describe('真实 HTTP 的独立文件模块（无数据库、测试替身仅在本文件）', () => {
  let app: INestApplication,
    store: BlobStore,
    principal: FilePrincipal = { tenantId: '1', userId: '1' },
    failCatalog = false,
    uncertainCommit = false;
  const files = new Map<string, StoredFile>();
  const fakeCatalog: FileCatalog = {
    ready: async () => {},
    insert: async (file) => {
      if (failCatalog)
        throw new FileMetadataWriteFailure(
          Error('测试保存失败'),
          !uncertainCommit,
        );
      const record = { ...file, id: String(files.size + 1) };
      files.set(record.id, record);
      return record;
    },
    // 故意不按租户过滤，验证服务第二道对象隔离检查，不能当成正式 Catalog 实现。
    find: async (id) => files.get(id) ?? null,
  };
  beforeAll(async () => {
    store = new LocalBlobStore(await temp());
    const module = await Test.createTestingModule({
      imports: [
        TestIdempotencyModule,
        FileModule.register({
          store,
          policy,
          access: { current: async () => principal },
          catalog: fakeCatalog,
        }),
      ],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(createValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  it('上传忽略原名称及客户端 MIME，下载是附件原始内容', async () => {
    const upload = await request(app.getHttpServer())
      .post('/admin/file/asset/upload')
      .attach('file', png, {
        filename: '../../run.php',
        contentType: 'text/html',
      })
      .expect(200);
    expect(upload.body.code).toBe(1000);
    const file = upload.body.data as {
      id: string;
      name: string;
      mime: string;
      key?: string;
    };
    expect(file.mime).toBe('image/png');
    expect(file.name).toMatch(/^[0-9a-f-]+\.png$/);
    expect(file.key).toBeUndefined();
    const download = await request(app.getHttpServer())
      .post('/admin/file/asset/download')
      .send({ id: file.id })
      .expect(200);
    expect(download.body).toEqual(png);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
  });
  it('上传幂等：同一个键同一个文件只存一次，换了文件内容 409', async () => {
    const before = files.size;
    const send = (content: Buffer) =>
      request(app.getHttpServer())
        .post('/admin/file/asset/upload')
        .set('Idempotency-Key', 'upload-key-0001')
        .attach('file', content, { filename: 'a.png' });
    const first = await send(png).expect(200);
    const again = await send(png).expect(200);
    expect(again.body.data).toEqual(first.body.data);
    expect(files.size).toBe(before + 1);
    await send(Buffer.concat([png, Buffer.from([0])])).expect(409);
    expect(files.size).toBe(before + 1);
  });
  it('跨租户和不存在 ID 同样404，不读取对象存储', async () => {
    principal = { tenantId: '2', userId: '2' };
    const get = vi.spyOn(store, 'get');
    const foreign = await request(app.getHttpServer())
      .post('/admin/file/asset/download')
      .send({ id: '1' })
      .expect(404);
    const missing = await request(app.getHttpServer())
      .post('/admin/file/asset/download')
      .send({ id: '999' })
      .expect(404);
    expect(foreign.body).toEqual(missing.body);
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
    principal = { tenantId: '1', userId: '1' };
  });
  it('拒绝假图片、超限文件及未声明字段', async () => {
    await request(app.getHttpServer())
      .post('/admin/file/asset/upload')
      .attach('file', Buffer.from('<script/>'), {
        filename: 'fake.png',
        contentType: 'image/png',
      })
      .expect(400);
    await request(app.getHttpServer())
      .post('/admin/file/asset/upload')
      .attach('file', Buffer.alloc(513), { filename: 'large.png' })
      .expect(413);
    await request(app.getHttpServer())
      .post('/admin/file/asset/upload')
      .field('tenantId', '2')
      .attach('file', png, { filename: 'x.png' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/admin/file/asset/download')
      .send({ id: '1', tenantId: '2' })
      .expect(400);
  });
  it('元数据失败时清理刚写的对象，不返回伪成功', async () => {
    failCatalog = true;
    const discard = vi.spyOn(store, 'discard');
    await request(app.getHttpServer())
      .post('/admin/file/asset/upload')
      .attach('file', png, { filename: 'x.png' })
      .expect(500);
    expect(discard).toHaveBeenCalledOnce();
    discard.mockRestore();
    failCatalog = false;
  });
  it('提交结果不确定时不删除可能已被引用的对象', async () => {
    failCatalog = true;
    uncertainCommit = true;
    const discard = vi.spyOn(store, 'discard');
    try {
      await request(app.getHttpServer())
        .post('/admin/file/asset/upload')
        .attach('file', png, { filename: 'x.png' })
        .expect(500);
      expect(discard).not.toHaveBeenCalled();
    } finally {
      discard.mockRestore();
      failCatalog = false;
      uncertainCommit = false;
    }
  });
  it('导出文档包含 multipart、二进制下载和明确权限扩展', () => {
    const doc = buildOpenApiDocument(app, 'test');
    // core 的 @Perms 写的是 x-permission（权限码 + 风险级别），前端据此生成权限常量
    expect(
      (
        doc.paths['/admin/file/asset/upload'].post as unknown as {
          'x-permission': { code: string };
        }
      )['x-permission'],
    ).toMatchObject({ code: 'file:asset:upload' });
    expect(
      doc.paths['/admin/file/asset/download'].post?.responses['200'],
    ).toMatchObject({
      content: {
        'application/octet-stream': {
          schema: { type: 'string', format: 'binary' },
        },
      },
    });
    expect(doc.components?.schemas?.FileReceipt).toBeDefined();
  });
  it('未装配真实认证时默认401，在解析上传内容之前拒绝', async () => {
    const module = await Test.createTestingModule({
      imports: [TestIdempotencyModule, FileModule.register({ store, policy })],
    }).compile();
    const denied = module.createNestApplication();
    denied.useLogger(false);
    denied.useGlobalFilters(new AllExceptionsFilter());
    await denied.init();
    try {
      await request(denied.getHttpServer())
        .post('/admin/file/asset/upload')
        .attach('file', Buffer.alloc(1000), { filename: 'x.png' })
        .expect(401);
    } finally {
      await denied.close();
    }
  });
  it('认证口已提供但正式 Catalog 未配置时503，写存储之前拒绝', async () => {
    const put = vi.spyOn(store, 'put');
    const module = await Test.createTestingModule({
      imports: [
        TestIdempotencyModule,
        FileModule.register({
          store,
          policy,
          access: { current: async () => principal },
        }),
      ],
    }).compile();
    const disabled = module.createNestApplication();
    disabled.useLogger(false);
    disabled.useGlobalFilters(new AllExceptionsFilter());
    await disabled.init();
    try {
      await request(disabled.getHttpServer())
        .post('/admin/file/asset/upload')
        .attach('file', png, { filename: 'x.png' })
        .expect(503);
      expect(put).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
      await disabled.close();
    }
  });
});
