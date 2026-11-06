import { Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { AppConfigService } from '../config/app-config.service.js';

const ISSUER = 'jna';
const AUDIENCE = 'jna:admin';

/** 访问令牌里的内容。前端不解析，只按 expiresIn 判断过期 */
export interface AccessClaims {
  tenantId: string;
  userId: string;
  sessionId: string;
  /** 会话版本：切换组织时加 1，旧访问令牌立即失效 */
  sessionVersion: number;
  orgId: string | null;
}

/** 后台访问令牌（JWT，HS256）。只证明「是我们签的、没过期」；会话是否还有效每次到 Redis 核对 */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(private readonly config: AppConfigService) {
    this.key = new TextEncoder().encode(config.auth.jwtSecret);
  }

  get accessTtlSeconds(): number {
    return this.config.auth.accessTtlSeconds;
  }

  sign(c: AccessClaims): Promise<string> {
    return new SignJWT({
      tid: c.tenantId,
      sid: c.sessionId,
      sv: c.sessionVersion,
      org: c.orgId,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(c.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtlSeconds}s`)
      .sign(this.key);
  }

  /** 签名、签发方、受众、有效期任何一项不对都返回 null */
  async verify(token: string): Promise<AccessClaims | null> {
    try {
      const { payload: p } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      if (
        typeof p.sub !== 'string' ||
        typeof p.tid !== 'string' ||
        typeof p.sid !== 'string' ||
        typeof p.sv !== 'number' ||
        !(p.org === null || typeof p.org === 'string')
      )
        return null;
      return {
        tenantId: p.tid,
        userId: p.sub,
        sessionId: p.sid,
        sessionVersion: p.sv,
        orgId: p.org,
      };
    } catch {
      return null;
    }
  }
}
