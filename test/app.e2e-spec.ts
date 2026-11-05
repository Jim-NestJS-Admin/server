import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Body,
  Controller,
  Get,
  HttpException,
  INestApplication,
  InternalServerErrorException,
  NotFoundException,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { BusinessException } from '../src/core/exceptions/business.exception.js';
import { ErrorCode } from '../src/core/exceptions/error-code.js';
import { HealthService } from '../src/core/health/health.service.js';
import { exportOpenApi } from '../src/scripts/export-openapi.js';

class CreateDemoDto {
  @IsString()
  @MaxLength(10)
  name!: string;

  @IsInt()
  @Min(1)
  qty!: number;
}

@Controller('demo')
class DemoController {
  constructor(private readonly cls: ClsService) {}
  @Get('ok') ok() {
    return { a: 1 };
  }
  @Get('empty') empty() {
    return undefined;
  }
  @Get('biz') biz() {
    throw new BusinessException(ErrorCode.Conflict, '名称已存在', 409);
  }
  @Get('missing') missing() {
    throw new NotFoundException('User not found');
  }
  @Get('boom') boom() {
    throw new Error('数据库密码是 hunter2');
  }
  @Get('internal-cn')
  internalCn() {
    throw new InternalServerErrorException('数据库连接失败 CANARY_INTERNAL');
  }
  @Get('unavailable-cn')
  unavailableCn() {
    throw new ServiceUnavailableException('Redis 地址 CANARY_REDIS 连不上');
  }
  @Get('http-502')
  http502() {
    throw new HttpException('上游网关 CANARY_GATEWAY', 502);
  }
  @Get('rid') rid() {
    return { id: this.cls.getId() };
  }
  @Post('dto') create(@Body() dto: CreateDemoDto) {
    return dto;
  }
}

describe('server 骨架（T02）', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [DemoController],
    }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  describe('统一响应', () => {
    it('成功响应包成 { code: 1000, data, message }', async () => {
      const r = await request(app.getHttpServer()).get('/demo/ok').expect(200);
      expect(r.body).toEqual({ code: 1000, data: { a: 1 }, message: 'ok' });
    });
    it('没有返回值时 data 为 null', async () => {
      const r = await request(app.getHttpServer())
        .get('/demo/empty')
        .expect(200);
      expect(r.body).toEqual({ code: 1000, data: null, message: 'ok' });
    });
  });

  describe('异常处理', () => {
    it('业务异常按指定的错误码、状态码和中文说明返回', async () => {
      const r = await request(app.getHttpServer()).get('/demo/biz').expect(409);
      expect(r.body).toEqual({
        code: ErrorCode.Conflict,
        data: null,
        message: '名称已存在',
      });
    });
    it('Nest 自带的英文异常换成中文默认文案', async () => {
      const r = await request(app.getHttpServer())
        .get('/demo/missing')
        .expect(404);
      expect(r.body).toEqual({
        code: ErrorCode.NotFound,
        data: null,
        message: '资源不存在',
      });
    });
    it('不存在的路由返回 4004', async () => {
      const r = await request(app.getHttpServer())
        .get('/no-such-route')
        .expect(404);
      expect(r.body.code).toBe(ErrorCode.NotFound);
    });
    it('未知异常只返回「服务器内部错误」，原始信息不出现在响应里', async () => {
      const r = await request(app.getHttpServer())
        .get('/demo/boom')
        .expect(500);
      expect(r.body).toEqual({
        code: ErrorCode.Internal,
        data: null,
        message: '服务器内部错误',
      });
      expect(JSON.stringify(r.body)).not.toContain('hunter2');
    });
  });

  describe('5xx 不外露内部信息（T02 审查修正）', () => {
    it('带中文说明的 500 也只返回公开文案', async () => {
      const r = await request(app.getHttpServer())
        .get('/demo/internal-cn')
        .expect(500);
      expect(r.body).toEqual({
        code: ErrorCode.Internal,
        data: null,
        message: '服务器内部错误',
      });
    });
    it('503 只返回「服务暂不可用」', async () => {
      const r = await request(app.getHttpServer())
        .get('/demo/unavailable-cn')
        .expect(503);
      expect(r.body).toEqual({
        code: ErrorCode.ServiceUnavailable,
        data: null,
        message: '服务暂不可用',
      });
    });
    it('其他 5xx 同样不外露', async () => {
      const r = await request(app.getHttpServer())
        .get('/demo/http-502')
        .expect(502);
      expect(JSON.stringify(r.body)).not.toContain('CANARY');
      expect(r.body.code).toBe(ErrorCode.Internal);
    });
  });

  describe('参数校验', () => {
    it('合法参数通过并完成类型转换', async () => {
      const r = await request(app.getHttpServer())
        .post('/demo/dto')
        .send({ name: 'abc', qty: 2 })
        .expect(201);
      expect(r.body.data).toEqual({ name: 'abc', qty: 2 });
    });
    it('不合法时返回 4000，按字段列出错误', async () => {
      const r = await request(app.getHttpServer())
        .post('/demo/dto')
        .send({ name: 'x'.repeat(11), qty: 0 })
        .expect(400);
      expect(r.body.code).toBe(ErrorCode.BadRequest);
      const fields = r.body.data.errors
        .map((e: { field: string }) => e.field)
        .sort();
      expect(fields).toEqual(['name', 'qty']);
    });
    it('DTO 没声明的字段被拒绝', async () => {
      const r = await request(app.getHttpServer())
        .post('/demo/dto')
        .send({ name: 'a', qty: 1, isAdmin: true })
        .expect(400);
      expect(
        r.body.data.errors.map((e: { field: string }) => e.field),
      ).toContain('isAdmin');
    });
  });

  describe('请求 ID', () => {
    it('沿用合法的上游请求 ID，写回响应头，并且就是上下文里的 ID', async () => {
      const r = await request(app.getHttpServer())
        .get('/demo/rid')
        .set('x-request-id', 'nginx-abc-12345')
        .expect(200);
      expect(r.headers['x-request-id']).toBe('nginx-abc-12345');
      expect(r.body.data.id).toBe('nginx-abc-12345');
    });
    it('没有或不合法时生成新的，响应头和上下文一致', async () => {
      const r = await request(app.getHttpServer())
        .get('/demo/rid')
        .set('x-request-id', 'bad id')
        .expect(200);
      expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.body.data.id).toBe(r.headers['x-request-id']);
    });
  });

  describe('健康检查', () => {
    it('原样返回，不包统一格式', async () => {
      const r = await request(app.getHttpServer()).get('/health').expect(200);
      expect(r.body).toEqual({ status: 'ok', checks: {} });
    });
    it('注册的检查失败时返回 503', async () => {
      const health = app.get(HealthService);
      health.register('fake-db', async () => {
        throw new Error('down');
      });
      const r = await request(app.getHttpServer()).get('/health').expect(503);
      expect(r.body).toEqual({
        status: 'error',
        checks: { 'fake-db': 'error' },
      });
      health.register('fake-db', async () => {});
      await request(app.getHttpServer()).get('/health').expect(200);
    });
  });
});

describe('接口文档导出', () => {
  it('导出 OpenAPI 3 文档，两次导出内容完全一样', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openapi-'));
    const a = readFileSync(await exportOpenApi(join(dir, 'a.json')), 'utf8');
    const b = readFileSync(await exportOpenApi(join(dir, 'b.json')), 'utf8');
    expect(a).toBe(b);
    const doc = JSON.parse(a);
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe('jim-nestjs-admin 接口');
    expect(Object.keys(doc.paths)).not.toContain('/health');
  });
});
