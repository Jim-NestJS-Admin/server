# jim-nestjs-admin-server

jim-nestjs-admin 的后端项目（NestJS）。设计文档、任务看板和协作规则在旁边的文档项目 `../docs/`，前端是 `../admin/`。

## 环境要求

- Node.js 22 及以上（见 `.nvmrc`）
- pnpm 10（`corepack enable` 后会按 `package.json` 里的版本自动使用）
- Docker（用来启动本地 MySQL 和 Redis）

## 本地启动

```bash
cp .env.example .env                                   # 按本机修改密码
docker compose --env-file .env -f deploy/docker-compose.yml up -d   # 启动 MySQL 8.4 和 Redis
pnpm install
pnpm start:dev                                         # 开发模式，改代码自动重启
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm start:dev` | 开发模式启动 |
| `pnpm build` | 构建到 `dist/` |
| `pnpm start:prod` | 运行构建结果 |
| `pnpm lint` | 代码检查（oxlint，带类型检查规则） |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm test` | 单元测试（vitest） |
| `pnpm test:e2e` | 端到端测试 |
| `pnpm format` / `pnpm format:check` | 格式化 / 检查格式（Prettier） |
| `pnpm openapi:export` | 导出接口文档到 `openapi/admin.json`（改了接口就要跑并提交，前端据此生成代码） |

提交前必须全部通过：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:e2e`、`pnpm build`、`pnpm format:check`。

## 当前状态

已完成 T01（项目骨架）、T02（server 骨架）：

- 启动时校验环境变量，缺项或格式不对直接启动失败（`src/core/config/`）
- 结构化日志（Pino），带请求 ID，授权头、Cookie、密码、令牌、密钥自动隐去
- 请求上下文（nestjs-cls），请求 ID 写回响应头 `x-request-id`
- 统一响应 `{ code, data, message }`，`code` 为 1000 表示成功；错误统一中文提示，未知错误不暴露内部信息
- 全局参数校验，DTO 没声明的字段直接拒绝
- 接口文档：开发环境访问 `/docs`，生产环境默认关闭
- 健康检查 `GET /health`（数据库、Redis 检查在接入后注册）
