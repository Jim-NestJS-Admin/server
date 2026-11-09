import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { createTestModule } from './support/test-auth.js';
import { clearTestRedis, rawRedis } from './support/test-redis.js';

describe('个人偏好（T18 常用查询）', () => {
  let app: INestApplication<App>;
  const as = (user: string, org: string | null) => {
    const h = (r: request.Test) => {
      r.set('x-test-user', user);
      if (org) r.set('x-test-org', org);
      return r;
    };
    return {
      get: (key: string) =>
        h(
          request(app.getHttpServer())
            .get('/admin/session/preference')
            .query({ key }),
        ),
      save: (key: string, value: unknown) =>
        h(
          request(app.getHttpServer()).post('/admin/session/preference/save'),
        ).send({ key, value }),
      del: (key: string) =>
        h(
          request(app.getHttpServer()).post('/admin/session/preference/delete'),
        ).send({ key }),
    };
  };

  beforeAll(async () => {
    // 权限缓存按「租户 + 用户 + 组织 + 版本」存一小时，先清掉上次运行留下的，免得用到旧结论
    const raw = rawRedis();
    await clearTestRedis(raw);
    await raw.quit();
    const m = await createTestModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    configureApp(app);
    await app.init();
    await app.get(DataSource).query('DELETE FROM sys_user_pref');
  });
  afterAll(() => app.close());

  it('按用户和当前组织隔离；覆盖保存；删除后为 null', async () => {
    const q = {
      name: '启用的',
      where: {
        op: 'and',
        items: [{ field: 'status', op: 'eq', value: 'enabled' }],
      },
    };
    await as('1', '10').save('query:system:user', q).expect(200);
    expect(
      (await as('1', '10').get('query:system:user').expect(200)).body.data
        .value,
    ).toEqual(q);
    expect(
      (await as('1', '20').get('query:system:user').expect(200)).body.data
        .value,
    ).toBeNull();
    expect(
      (await as('2', '10').get('query:system:user').expect(200)).body.data
        .value,
    ).toBeNull();
    await as('1', '10').save('query:system:user', { name: '新' }).expect(200);
    expect(
      (await as('1', '10').get('query:system:user').expect(200)).body.data
        .value,
    ).toEqual({ name: '新' });
    await as('1', '10').del('query:system:user').expect(200);
    expect(
      (await as('1', '10').get('query:system:user').expect(200)).body.data
        .value,
    ).toBeNull();
  });

  it('键格式不对、内容超过 64KB：400', async () => {
    await as('1', null).save('Bad Key', 1).expect(400);
    await as('1', null).save('big', 'x'.repeat(70000)).expect(400);
  });
});
