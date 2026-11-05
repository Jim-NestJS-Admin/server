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
| `pnpm test:e2e` | 端到端测试（连真实 MySQL 的测试库，见下文） |
| `pnpm format` / `pnpm format:check` | 格式化 / 检查格式（Prettier） |
| `pnpm openapi:export` | 导出接口文档到 `openapi/admin.json`（改了接口就要跑并提交，前端据此生成代码） |

提交前必须全部通过：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:e2e`、`pnpm build`、`pnpm format:check`。

### 端到端测试用的数据库

端到端测试连 `.env` 里同一个 MySQL，但库名换成 `<DB_NAME>_test`（例如 `jim_admin_test`），并在测试环境自动建表。测试会清空这个库，**不要**让它指向开发库。

- 第一次用 compose 启动 MySQL 时，`deploy/mysql-init/` 会自动建好测试库并授权给应用账号。
- 如果 MySQL 数据卷是在加这个脚本之前建的（初始化脚本只在第一次执行），手动建一次：

  ```bash
  docker compose --env-file .env -f deploy/docker-compose.yml exec mysql \
    sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}_test\`; GRANT ALL ON \`${MYSQL_DATABASE}_test\`.* TO \"$MYSQL_USER\"@\"%\";"'
  ```

- 想换测试库名，设置环境变量 `DB_TEST_NAME`。

## 当前状态

已完成 T01（项目骨架）、T02（server 骨架），T03（通用 CRUD）进行中：

- 启动时校验环境变量，缺项或格式不对直接启动失败（`src/core/config/`）
- 结构化日志（Pino），带请求 ID，授权头、Cookie、密码、令牌、密钥自动隐去
- 请求上下文（nestjs-cls），请求 ID 写回响应头 `x-request-id`
- 统一响应 `{ code, data, message }`，`code` 为 1000 表示成功；错误统一中文提示，未知错误不暴露内部信息
- 全局参数校验，DTO 没声明的字段直接拒绝
- 接口文档：开发环境访问 `/docs`，生产环境默认关闭
- 健康检查 `GET /health`（已注册数据库检查；Redis 在 T04 接入后注册）
- 数据库：MySQL + TypeORM，表名、列名小写下划线，bigint 一律按字符串返回（`src/core/database/`）
- 通用 CRUD 验收点②：主子表聚合保存。`children` 配置多个子表；新增时每个子表提交 `added`，修改时提交 `added` / `updated` / `deleted` 三组，没提交的行不动；子行归属、clientId、行数上下限、单据内唯一都在同一事务里检查，主表版本号统一控制并发；详情返回 `children`；子表实体不能有自己的写接口
- 通用 CRUD 验收点①（`src/core/crud/`）：`@CrudController` 按配置生成分页、详情、新增、修改、删除接口和页面描述 `GET /admin/<资源>/schema`；乐观锁（编号 + 旧版本号 + 范围条件一条更新）、批量删除整批成败、软删除 / 硬删除、钩子在事务里执行；不存在和无权访问统一 404 / 4004，版本冲突 409 / 4009，参数和唯一冲突 400 / 4000
