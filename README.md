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

已完成 T01（项目骨架）、T02（server 骨架）、T03（通用 CRUD），T04（租户与多端）待审查：

- 启动时校验环境变量，缺项或格式不对直接启动失败（`src/core/config/`）
- 结构化日志（Pino），带请求 ID，授权头、Cookie、密码、令牌、密钥自动隐去
- 请求上下文（nestjs-cls），请求 ID 写回响应头 `x-request-id`
- 统一响应 `{ code, data, message }`，`code` 为 1000 表示成功；错误统一中文提示，未知错误不暴露内部信息
- 全局参数校验，DTO 没声明的字段直接拒绝
- 接口文档：开发环境访问 `/docs`，生产环境默认关闭
- 健康检查 `GET /health`（已注册数据库检查；Redis 在 T04 接入后注册）
- 数据库：MySQL + TypeORM，表名、列名小写下划线，bigint 一律按字符串返回（`src/core/database/`）
- 租户与多端（T04，`src/core/tenant/`、`src/core/endpoint/`）：控制器用 `@AdminController` 等声明所属的端，全局守卫按端认证后把租户、用户、组织写进请求上下文（没有上下文的读写直接报错，后台任务用 `RequestContext.run`）；`TenantRepositoryFactory` 给不走通用 CRUD 的实体自动带租户；`@IgnoreTenant` 只给平台租户、只能读；写入保险拦住往别的租户写或改租户。后台登录（T05）接入前用阶段 1 占位认证（默认租户匿名用户），生产环境不能启动
- 通用 CRUD 验收点③：删除方式与回收站。软删除表的唯一约束建在「租户 + 业务字段 + activeGuard」上（`activeGuard` 是基类里的生成列，未删除为 1、已删除为空），删掉的业务键可以重用；`api` 里开 `recycle` / `restore` / `purge` 得到回收站列表、恢复、彻底删除，恢复撞名整批回滚；删除批次让恢复主表时只恢复同批子行；真删前整行留底（`CrudAudit`，现在写日志，T08 改为落库）；唯一约束写错启动时报错
- 通用 CRUD 验收点②：主子表聚合保存。`children` 配置多个子表；新增时每个子表提交 `added`，修改时提交 `added` / `updated` / `deleted` 三组，没提交的行不动；子行归属、clientId、行数上下限、单据内唯一都在同一事务里检查，主表版本号统一控制并发；详情返回 `children`；子表实体不能有自己的写接口
- 通用 CRUD 验收点①（`src/core/crud/`）：`@CrudController` 按配置生成分页、详情、新增、修改、删除接口和页面描述 `GET /admin/<资源>/schema`；乐观锁（编号 + 旧版本号 + 范围条件一条更新）、批量删除整批成败、软删除 / 硬删除、钩子在事务里执行；不存在和无权访问统一 404 / 4004，版本冲突 409 / 4009，参数和唯一冲突 400 / 4000
# 本地登录初始化（T07 子批次）

`codex/T07-login-bootstrap` 补齐认证需要的 MySQL 用户、组织、角色分配及菜单读取适配器。用户密码只存 bcrypt 哈希；查询使用租户 Repository，角色和组织计算继续由 core 负责。本批没有开放用户或角色管理写接口，T07 整体尚未完成。

本地独立环境使用 `jim_admin_local`，后端端口3011、Redis端口6387，前端地址 `http://localhost:8848`。连接信息、随机签名密钥和初始密码仅存本地被忽略的 `.env`，不提交。前端本地 `VITE_ADMIN_PROXY_TARGET=http://localhost:3011`，生产仍须同源反向代理。

准备独立本地数据库 `jim_admin_local`、应用连接权限和 Redis 后，执行 `pnpm bootstrap:local`（T10）。脚本只允许 development、本机地址和这个库名：先运行版本化迁移，再在单个事务内补齐默认菜单和按钮（系统管理、开发工具，以及代码生成器写出的 `src/modules/*/*.menu.json`；权限码没在后端声明的页面跳过，已有菜单不改）、基础字典，库里还没有用户时创建默认组织、超管角色和账号。账号默认 `admin` / `123456`（只限本机开发库，登录后请修改），可用 `.env` 里的 `BOOTSTRAP_USERNAME` / `BOOTSTRAP_PASSWORD` 覆盖；已有用户时不创建、不改密码。生成了新模块后用 `pnpm menus:local` 只补菜单。不要对其他项目或生产数据库运行。

同时修复T06审查发现的Anonymous与Perms/LoginOnly混用：启动检查拒绝（包括继承的方法），守卫也直接拒绝矛盾声明。此修复待Claude复核，不代表T06整体验收。

## T17 字段配置（代码阶段）

本分支合入Claude的T16引擎0a88f41，在system模块实现sys_field/sys_role_field、租户感知FieldPermSource、配置CRUD、配置页专用overview读模型及save批量接口。模块默认和角色覆盖分别读写，保存后授权版本失效；跟随默认删除覆盖，配置快照和写入在同一事务提交。批量修改锁行检查版本，任一项冲突整批回滚。所有配置写接口声明高风险。迁移1793941200000已登记，尚未应用到本地开发库。

代码清单由CrudRuntime与FieldPerm读取，系统字段、未知字段、configurable:false字段一律拒绝；旧配置失效后不再作为权限来源。委派只能收紧代码声明。安全配置页本身不进入字段配置清单。overview提供完整DTO和版本，前端从正式OpenAPI生成，不依赖T16目前为通用object的registry响应。

本轮仅类型检查、lint、构建/接口导出；测试文件已补，按Jimmy要求不执行。T16逐行字段状态契约仍待补充；T08硬删除审计注入点待Claude提供，当前配置变更已用独立同事务审计方法落库。

## T09 应用装配（代码阶段）

文件模块现在显式注册到AppModule，使用真实session鉴权、数据库目录和私有本地存储deploy/data/files（必须作为持久卷挂载，不能作为静态站点目录）。默认10MiB，PNG/JPEG/WebP/PDF按实际内容识别；现有S3/OSS适配器保留为可替换装配口，没有硬编码云凭据。目录与下载复用core数据范围，上传记录当前组织。file_asset、兼容org_id迁移已登记到本地迁移入口；初始文件迁移先确保TypeORM生成列元数据表存在，支持它早于system初始迁移执行。

节点类型/lint/构建及OpenAPI导出通过；未运行测试、未执行迁移。T25幂等与限流尚未合入此分支，文件二进制存储与数据库事务的失败补偿、multipart幂等内容摘要需要在安全集成批次核对。此处不宣称T09整体运行验收完成。
