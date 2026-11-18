import { Injectable } from '@nestjs/common';
import { request } from 'node:https';
import { assertPublicUrl } from '../../../core/security/ssrf.js';
import { RedisService } from '../../../core/redis/redis.service.js';
import { RequestContext } from '../../../core/tenant/request-context.js';
import { IntegrationApp } from '../entity/integration.entity.js';

export interface PlatformDepartment {
  id: number;
  parentid: number;
  name: string;
  order: number;
}
export interface PlatformMember {
  userid: string;
  name: string;
  department: number[];
  main_department?: number;
  status: number;
}
export abstract class IntegrationAdapter {
  abstract user(
    app: IntegrationApp,
    secret: string,
    code: string,
  ): Promise<string>;
  abstract departments(
    app: IntegrationApp,
    secret: string,
  ): Promise<PlatformDepartment[]>;
  abstract members(
    app: IntegrationApp,
    secret: string,
    department: number,
  ): Promise<PlatformMember[]>;
}

@Injectable()
export class WecomAdapter extends IntegrationAdapter {
  constructor(
    private readonly redis: RedisService,
    private readonly context: RequestContext,
  ) {
    super();
  }
  private async http(
    path: string,
    params: Record<string, string>,
    body?: object,
  ): Promise<Record<string, unknown>> {
    const target = new URL('https://qyapi.weixin.qq.com/cgi-bin/' + path);
    for (const [key, value] of Object.entries(params))
      target.searchParams.set(key, value);
    const checked = await assertPublicUrl(target.toString());
    const data = body ? JSON.stringify(body) : undefined;
    return new Promise((resolve, reject) => {
      const req = request(
        checked.url,
        {
          method: data ? 'POST' : 'GET',
          lookup: (_host, _options, cb) =>
            cb(null, checked.address, checked.family),
          headers: data
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
              }
            : {},
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) req.destroy();
            else chunks.push(chunk);
          });
          response.on('error', () => reject(new Error('企业微信响应失败')));
          response.on('end', () => {
            try {
              if (response.statusCode !== 200 || size > 2 * 1024 * 1024)
                throw new Error();
              const out: unknown = JSON.parse(
                Buffer.concat(chunks).toString('utf8'),
              );
              if (!out || typeof out !== 'object' || Array.isArray(out))
                throw new Error();
              resolve(out as Record<string, unknown>);
            } catch {
              reject(new Error('企业微信响应无效'));
            }
          });
        },
      );
      const timeout = setTimeout(() => req.destroy(), 15000);
      req.on('close', () => clearTimeout(timeout));
      req.on('error', () => reject(new Error('企业微信请求失败')));
      req.end(data);
    });
  }
  private tokenKey(app: IntegrationApp) {
    return this.redis.tenantKey(
      this.context.current().tenantId,
      'integration',
      'wecom',
      app.id,
      String(app.version),
      'token',
    );
  }
  private async token(app: IntegrationApp, secret: string) {
    const key = this.tokenKey(app);
    const cached = await this.redis.call((r) => r.get(key));
    if (cached) return cached;
    const result = await this.http('gettoken', {
      corpid: app.corpId,
      corpsecret: secret,
    });
    if (
      (result.errcode !== undefined && result.errcode !== 0) ||
      typeof result.access_token !== 'string' ||
      typeof result.expires_in !== 'number'
    )
      throw new Error('获取企业微信凭据失败');
    await this.redis.call((r) =>
      r.set(
        key,
        result.access_token as string,
        'EX',
        Math.max(1, (result.expires_in as number) - 120),
      ),
    );
    return result.access_token;
  }
  async api(
    app: IntegrationApp,
    secret: string,
    path: string,
    params: Record<string, string> = {},
    body?: object,
    allowMissingMember = false,
  ) {
    for (let retry = 0; retry < 2; retry++) {
      const result = await this.http(
        path,
        { ...params, access_token: await this.token(app, secret) },
        body,
      );
      if ([40014, 42001].includes(Number(result.errcode)) && retry === 0) {
        await this.redis.call((r) => r.del(this.tokenKey(app)));
        continue;
      }
      if (allowMissingMember && result.errcode === 60111) return result;
      if (result.errcode !== undefined && result.errcode !== 0)
        throw new Error('企业微信接口拒绝请求');
      return result;
    }
    throw new Error('企业微信凭据已失效');
  }
  async user(app: IntegrationApp, secret: string, code: string) {
    const result = await this.api(app, secret, 'auth/getuserinfo', { code });
    if (typeof result.userid !== 'string')
      throw new Error('企业微信没有返回企业成员身份');
    return result.userid;
  }
  async memberExists(app: IntegrationApp, secret: string, userId: string) {
    const result = await this.api(
      app,
      secret,
      'user/get',
      { userid: userId },
      undefined,
      true,
    );
    if (result.errcode === 60111) return false;
    if (result.userid !== userId) throw new Error('企业微信成员核对失败');
    return true;
  }
  async departments(app: IntegrationApp, secret: string) {
    const out = await this.api(app, secret, 'department/list');
    if (!Array.isArray(out.department)) throw new Error('部门目录无效');
    return out.department as PlatformDepartment[];
  }
  async members(app: IntegrationApp, secret: string, department: number) {
    const out = await this.api(app, secret, 'user/list', {
      department_id: String(department),
      fetch_child: '0',
    });
    if (!Array.isArray(out.userlist)) throw new Error('成员目录无效');
    return out.userlist as PlatformMember[];
  }
}
