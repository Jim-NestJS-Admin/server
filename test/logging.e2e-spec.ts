import { Writable } from 'node:stream';
import { Body, Controller, Get, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger, LoggerModule, PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { Public } from '../src/core/endpoint/endpoint.decorators.js';
import { buildLoggerOptions } from '../src/core/logger/logger.options.js';

@Public()
@Controller('log-demo')
class LogDemoController {
  constructor(private readonly logger: PinoLogger) {}
  @Get() get() {
    return 'ok';
  }
  @Post() post(@Body() body: Record<string, unknown>) {
    // 模拟业务代码把整个请求体写进日志
    this.logger.info(
      { body, nested: { deep: [{ token: 'CANARY_LOGGED_TOKEN' }] } },
      '收到请求',
    );
    return 'ok';
  }
}

describe('真实 HTTP 访问日志（T02 审查修正）', () => {
  let app: INestApplication<App>;
  let lines: string[] = [];

  beforeAll(async () => {
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const mod = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot(
          buildLoggerOptions({ level: 'info', pretty: false, stream }),
        ),
      ],
      controllers: [LogDemoController],
    }).compile();
    app = mod.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    lines = [];
  });

  it('URL 里的令牌、请求头里的授权和 Cookie 不进日志，普通参数和请求 ID 保留', async () => {
    await request(app.getHttpServer())
      .get('/log-demo?page=3&token=CANARY_URL_TOKEN&access_token=CANARY_URL_AT')
      .set('authorization', 'Bearer CANARY_AUTH_HEADER')
      .set('cookie', 'sid=CANARY_COOKIE')
      .set('x-api-key', 'CANARY_API_KEY')
      .set('x-request-id', 'req-log-test-001')
      .expect(200);
    const text = lines.join('');
    expect(text).toContain('page=3');
    expect(text).toContain('req-log-test-001');
    expect(text).not.toMatch(/CANARY_/);
  });

  it('来源页 Referer 只记域名和路径，查询参数、#后内容和 URL 里的账号密码都不进日志', async () => {
    await request(app.getHttpServer())
      .get('/log-demo')
      .set(
        'referer',
        'https://CANARY_USER:CANARY_PASS@sso.example.com/callback/wecom?code=CANARY_REF_CODE&state=s1#access_token=CANARY_REF_FRAG',
      )
      .expect(200);
    const text = lines.join('');
    expect(text).toContain('https://sso.example.com/callback/wecom');
    expect(text).not.toMatch(/CANARY_/);
  });

  it('解析不了或不是网页地址的 Referer 整个不记', async () => {
    await request(app.getHttpServer())
      .get('/log-demo')
      .set('referer', 'javascript:CANARY_JS')
      .expect(200);
    await request(app.getHttpServer())
      .get('/log-demo')
      .set('referer', 'not a url CANARY_RAW')
      .expect(200);
    expect(lines.join('')).not.toMatch(/CANARY_/);
  });

  it('业务代码记录的对象里，任意层级的敏感字段都被隐去', async () => {
    await request(app.getHttpServer())
      .post('/log-demo')
      .send({
        username: 'admin',
        password: 'CANARY_BODY_PASSWORD',
        profile: { secret: 'CANARY_BODY_SECRET' },
      })
      .expect(201);
    const text = lines.join('');
    expect(text).toContain('收到请求');
    expect(text).toContain('admin');
    expect(text).not.toMatch(/CANARY_/);
  });
});
