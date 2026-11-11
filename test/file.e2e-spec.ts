import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AdminAuth } from '../src/core/endpoint/endpoint-auth.js';
import { RequestContext } from '../src/core/tenant/request-context.js';
import { PermissionSource } from '../src/core/permission/permission-source.js';
import { AllowAllPermissionSource } from './support/test-auth.js';
import { FileModule } from '../src/modules/file/file.module.js';
import type { FilePrincipal } from '../src/modules/file/file.ports.js';
import { BlobStore } from '../src/modules/file/storage/blob-store.js';
import { TenantQuotaService } from '../src/modules/tenant/service/tenant-quota.service.js';

/** 只在独立测试库执行；身份头只供测试认证，不进入生产模块。 */
@Injectable()
class FileTestAuth extends AdminAuth {
  async authenticate(req: Request) {
    return {
      tenantId: req.header('x-test-tenant') ?? '1',
      userId: '7',
      orgId: null,
    };
  }
  async resolveTenant() {
    return '1';
  }
}

describe('T09 数据库目录与上传下载', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  const blobs = new Map<string, Buffer>();
  const store: BlobStore = {
    put: async (key, bytes) => {
      blobs.set(key, bytes);
    },
    get: async (key) => blobs.get(key)!,
    discard: async (key) => {
      blobs.delete(key);
    },
  };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
    'base64',
  );
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        AppModule,
        FileModule.register({
          store,
          policy: { maxBytes: 512, mimeTypes: ['image/png'] },
          catalog: 'database',
          access: {
            current: async (): Promise<FilePrincipal> => {
              const p = app.get(RequestContext).current();
              return { tenantId: p.tenantId, userId: p.userId! };
            },
          },
        }),
      ],
    })
      .overrideProvider(AdminAuth)
      .useClass(FileTestAuth)
      .overrideProvider(BlobStore)
      .useValue(store)
      .overrideProvider(TenantQuotaService)
      .useValue({
        assertStorage: async () => undefined,
        assertCanAddUser: async () => undefined,
      })
      .overrideProvider(PermissionSource)
      .useClass(AllowAllPermissionSource)
      .compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    const [{ db }] = await ds.query('SELECT DATABASE() db');
    expect(db).toMatch(/_test$/);
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    await ds.query('DELETE FROM file_asset');
    blobs.clear();
  });

  it('真实持久化取上下文身份；分页详情不暴露对象名和摘要', async () => {
    const uploaded = await request(app.getHttpServer())
      .post('/admin/file/asset/upload')
      .set('x-test-tenant', '2')
      .attach('file', png, 'untrusted.exe')
      .expect(200);
    const { id } = uploaded.body.data;
    const [stored] = await ds.query(
      'SELECT tenant_id, created_by, object_key, sha256 FROM file_asset WHERE id = ?',
      [id],
    );
    expect(stored).toMatchObject({ tenant_id: '2', created_by: '7' });
    expect(stored.object_key).toMatch(/^tenants\/2\//);
    const info = await request(app.getHttpServer())
      .post('/admin/file/asset/info')
      .set('x-test-tenant', '2')
      .send({ id })
      .expect(200);
    expect(info.body.data).toMatchObject({
      id,
      mime: 'image/png',
      bytes: png.length,
    });
    expect(info.body.data).not.toHaveProperty('objectKey');
    expect(info.body.data).not.toHaveProperty('sha256');
    expect(info.body.data).not.toHaveProperty('tenantId');
    await request(app.getHttpServer())
      .post('/admin/file/asset/download')
      .set('x-test-tenant', '2')
      .send({ id })
      .expect(200)
      .expect('Content-Type', /octet-stream/);
  });

  it('跨租户详情与下载同不存在，列表为空，不能使用通用写路由', async () => {
    const uploaded = await request(app.getHttpServer())
      .post('/admin/file/asset/upload')
      .set('x-test-tenant', '1')
      .attach('file', png, 'a.png')
      .expect(200);
    for (const action of ['info', 'download']) {
      const foreign = await request(app.getHttpServer())
        .post(`/admin/file/asset/${action}`)
        .set('x-test-tenant', '2')
        .send({ id: uploaded.body.data.id })
        .expect(404);
      const missing = await request(app.getHttpServer())
        .post(`/admin/file/asset/${action}`)
        .set('x-test-tenant', '2')
        .send({ id: '99999999' })
        .expect(404);
      expect(foreign.body).toEqual(missing.body);
    }
    const page = await request(app.getHttpServer())
      .post('/admin/file/asset/page')
      .set('x-test-tenant', '2')
      .send({})
      .expect(200);
    expect(page.body.data.total).toBe(0);
    for (const action of ['add', 'update', 'delete'])
      await request(app.getHttpServer())
        .post(`/admin/file/asset/${action}`)
        .send({})
        .expect(404);
  });
});
