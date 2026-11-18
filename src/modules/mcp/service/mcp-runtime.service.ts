import { Injectable, type INestApplication } from '@nestjs/common';
import {
  createMcpHandler,
  McpServer,
  inputRequired,
  CLIENT_CAPABILITIES_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { RedisService } from '../../../core/redis/redis.service.js';
import type {
  Request as HttpRequest,
  Response as HttpResponse,
  NextFunction,
} from 'express';
import { AppConfigService } from '../../../core/config/app-config.service.js';
import {
  OAuthRuntimeService,
  type OAuthDelegation,
} from '../../oauth/service/oauth-runtime.service.js';
import { OAuthScopesService } from '../../oauth/service/oauth-scopes.service.js';
import { buildOpenApiDocument } from '../../../core/swagger/swagger.js';
import { McpService } from './mcp.service.js';
import { BusinessException } from '../../../core/exceptions/business.exception.js';

const object = z.record(z.string(), z.unknown());
@Injectable()
export class McpRuntimeService {
  constructor(
    private readonly config: AppConfigService,
    private readonly oauth: OAuthRuntimeService,
    private readonly scopes: OAuthScopesService,
    private readonly mcp: McpService,
    private readonly redis: RedisService,
  ) {}
  private get audience() {
    return `${this.config.oauth.issuer.replace(/\/oauth$/, '')}/mcp`;
  }
  private async server(identity: OAuthDelegation) {
    const server = new McpServer({ name: 'jim-admin', version: '1.0.0' });
    const response = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    });
    const safe =
      (fn: () => Promise<unknown>, ctx?: ServerContext) => async () => {
        try {
          await this.mcp.toolAudit(identity, 'tool.started');
          await this.mcp.budget(identity);
          const value = await fn();
          await this.mcp.toolAudit(identity, 'tool.completed');
          const pending = value as
            { status?: string; confirmUrl?: string } | undefined;
          // SDK 2.4的中立envelope类型为空对象，实际键由公开常量确定；能力只决定链接呈现，不参与授权。
          const capabilities = (
            ctx?.mcpReq.envelope as
              Record<string, { elicitation?: { url?: object } }> | undefined
          )?.[CLIENT_CAPABILITIES_META_KEY];
          if (
            pending?.status === 'pending' &&
            pending.confirmUrl &&
            capabilities?.elicitation?.url
          )
            return inputRequired({
              inputRequests: {
                confirm: inputRequired.elicitUrl({
                  url: pending.confirmUrl,
                  message:
                    '请本人在后台核对并确认此操作。客户端的回答不会执行操作。',
                }),
              },
            });
          return response(value);
        } catch (error) {
          await this.mcp.toolAudit(identity, 'tool.rejected');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  error instanceof BusinessException
                    ? error.message
                    : '调用失败，请检查当前授权、参数及业务状态',
              },
            ],
          };
        }
      };
    const resource = z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/),
      input = object.default({}),
      requestId = z
        .string()
        .regex(/^[A-Za-z0-9_-]{8,64}$/)
        .optional();
    server.registerTool(
      'list_resources',
      {
        description: '列出当前权限、scope及租户策略允许的资源',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      safe(async () => ({
        resources: [
          ...new Set(
            (await this.mcp.visible(identity)).map((action) => action.resource),
          ),
        ],
      })),
    );
    server.registerTool(
      'describe_resource',
      {
        description: '查看已裁剪的字段、查询约定和可用动作',
        inputSchema: z.object({ resource }),
        annotations: { readOnlyHint: true },
      },
      (args) => safe(() => this.mcp.describe(identity, args.resource))(),
    );
    for (const [tool, action] of [
      ['query', 'page'],
      ['get', 'info'],
      ['create', 'add'],
      ['update', 'update'],
      ['delete', 'delete'],
    ] as const)
      server.registerTool(
        tool,
        {
          description: `${tool}：参数与该资源现有CRUD接口相同，先describe_resource；写请求重试保持requestId`,
          inputSchema: z.object({ resource, input, requestId }),
          annotations: {
            readOnlyHint: ['query', 'get'].includes(tool),
            destructiveHint: !['query', 'get'].includes(tool),
          },
        },
        (args, ctx) =>
          safe(
            () =>
              this.mcp.call(
                identity,
                args.resource,
                action,
                args.input,
                args.requestId,
              ),
            ctx,
          )(),
      );
    server.registerTool(
      'invoke_action',
      {
        description:
          '执行资源现有业务动作；高风险仅产生后台待确认记录。参数不能改变已冻结操作',
        inputSchema: z.object({
          resource,
          action: z.string().min(1).max(100),
          input,
          requestId,
        }),
        annotations: { destructiveHint: true },
      },
      (args, ctx) =>
        safe(
          () =>
            this.mcp.call(
              identity,
              args.resource,
              args.action,
              args.input,
              args.requestId,
            ),
          ctx,
        )(),
    );
    server.registerTool(
      'operation_status',
      {
        description: '查询本次应用和用户发起的操作结果，不执行或确认操作',
        inputSchema: z.object({
          operationId: z.string().regex(/^[1-9]\d{0,19}$/),
        }),
        annotations: { readOnlyHint: true },
      },
      (args) => safe(() => this.mcp.status(identity, args.operationId))(),
    );
    for (const name of new Set(
      (await this.mcp.visible(identity)).map((action) => action.resource),
    ))
      server.registerResource(
        name,
        `jim-admin://schema/${name}`,
        { description: '当前身份可见的资源结构', mimeType: 'application/json' },
        async (uri) => ({
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(await this.mcp.describe(identity, name)),
            },
          ],
        }),
      );
    server.registerPrompt(
      'safe-business-draft',
      { description: '查询现有结构后创建业务草稿，重要操作等待后台本人确认' },
      async () => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: '先list_resources和describe_resource，按可见字段和现有动作准备草稿。不要猜权限或参数，不自动发布。遇到confirmUrl请交给本人在后台核对；不要尝试替本人确认。',
            },
          },
        ],
      }),
    );
    return server;
  }
  mount(app: INestApplication) {
    this.mcp.registry.document = () => buildOpenApiDocument(app, '1.0.0');
    const instance = app.getHttpAdapter().getInstance() as {
      get(
        path: string,
        fn: (req: HttpRequest, res: HttpResponse) => void,
      ): void;
      use(
        path: string,
        fn: (req: HttpRequest, res: HttpResponse, next: NextFunction) => void,
      ): void;
    };
    const metadataPath = '/.well-known/oauth-protected-resource/mcp';
    for (const path of [metadataPath, '/.well-known/oauth-protected-resource'])
      instance.get(path, (_req, res) => {
        if (!this.config.mcpEnabled) {
          res.status(404).end();
          return;
        }
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json({
          resource: this.audience,
          authorization_servers: [this.config.oauth.issuer],
          bearer_methods_supported: ['header'],
          scopes_supported: this.scopes.list().list.map((item) => item.code),
        });
      });
    instance.use('/mcp', (req, res) => {
      void (async () => {
        if (!this.config.mcpEnabled || !this.config.oauth.enabled) {
          res.status(404).end();
          return;
        }
        if (req.path !== '/' && req.path !== '') {
          res.status(404).end();
          return;
        }
        const origin = req.get('origin');
        if (
          origin &&
          ![
            ...this.config.auth.adminOrigins,
            ...this.config.mcpOrigins,
            new URL(this.audience).origin,
          ].includes(origin)
        ) {
          res.status(403).end();
          return;
        }
        if (origin) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        }
        res.setHeader(
          'Access-Control-Expose-Headers',
          'WWW-Authenticate,MCP-Protocol-Version',
        );
        if (req.method === 'OPTIONS') {
          res.setHeader(
            'Access-Control-Allow-Methods',
            'POST,GET,DELETE,OPTIONS',
          );
          res.setHeader(
            'Access-Control-Allow-Headers',
            'Authorization,Content-Type,Accept,MCP-Protocol-Version,Mcp-Method,Mcp-Name',
          );
          res.status(204).end();
          return;
        }
        const challenge = `Bearer resource_metadata="${this.audience.replace(/\/mcp$/, '')}${metadataPath}"`;
        const ip = createHash('sha256')
          .update(req.ip ?? 'unknown')
          .digest('hex');
        const count = await this.redis.call((r) =>
          r.eval(
            "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60)end;return n",
            1,
            this.redis.tenantKey('0', 'mcp', 'ip', ip),
          ),
        );
        if (Number(count) > this.config.security.ipPerMinute) {
          res.setHeader('Retry-After', '60');
          res.status(429).json({ error: 'rate_limit_exceeded' });
          return;
        }
        const match = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') ?? '');
        if (!match) {
          res.setHeader('WWW-Authenticate', challenge);
          res.status(401).json({ error: 'invalid_token' });
          return;
        }
        let authenticated = false;
        try {
          await this.oauth.withDelegation(
            match[1]!,
            this.audience,
            async (identity) => {
              authenticated = true;
              await this.mcp.gate(identity);
              await this.mcp.rate(identity);
              const handler = createMcpHandler(async () =>
                this.server(identity),
              );
              const headers = new Headers();
              for (const [key, value] of Object.entries(req.headers))
                if (typeof value === 'string' && key !== 'authorization')
                  headers.set(key, value);
              const request = new Request(this.audience, {
                method: req.method,
                headers,
                ...(['GET', 'HEAD'].includes(req.method)
                  ? {}
                  : { body: JSON.stringify(req.body ?? {}) }),
              });
              const result = await handler.fetch(request, {
                parsedBody: req.body,
              });
              res.status(result.status);
              result.headers.forEach((value, key) => res.setHeader(key, value));
              if (result.body) {
                const reader = result.body.getReader();
                try {
                  while (!res.destroyed) {
                    const next = await reader.read();
                    if (next.done) break;
                    res.write(Buffer.from(next.value));
                  }
                } finally {
                  await reader.cancel();
                }
              }
              res.end();
            },
          );
        } catch (error) {
          if (res.headersSent) {
            res.end();
            return;
          }
          const status =
            error instanceof BusinessException
              ? error.getStatus()
              : !authenticated
                ? 401
                : 403;
          if (status === 401) res.setHeader('WWW-Authenticate', challenge);
          res.status(status).json({
            error:
              status === 401
                ? 'invalid_token'
                : status === 429
                  ? 'rate_limit_exceeded'
                  : 'access_denied',
          });
        }
      })().catch(() => {
        if (!res.headersSent)
          res.status(503).json({ error: 'temporarily_unavailable' });
        else res.end();
      });
    });
  }
}
