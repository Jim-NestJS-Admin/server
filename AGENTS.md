# AGENTS.md（server 项目）

本项目是 jim-nestjs-admin 的**后端**，独立 git 仓库。前端是旁边的 `../admin/`，另一个独立仓库；设计文档在 `../docs/`。

**开始任何工作之前，必须先读完 `../docs/AGENTS.md`（总规则）**，以及 `../docs/ARCHITECTURE.md`、`../docs/TASKS.md`。本文件只写后端项目的补充规则，和总规则冲突时以总规则为准。

## 后端补充规则

1. 技术栈以本项目 `package.json` 为准：NestJS 12、TypeScript、ES 模块（`"type": "module"`，源码里相对导入要写 `.js` 后缀）、oxlint、Prettier、vitest。
2. 提交前必须通过：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:e2e`、`pnpm build`、`pnpm format:check`。
3. 分支：Claude 用 `claude/<任务编号>-<简述>`，Codex 用 `codex/<任务编号>-<简述>`。任务同时改前后端时，`../admin/` 用同名分支。
4. 改了接口必须运行 `pnpm openapi:export` 并提交 `openapi/admin.json`，前端据此生成代码。
5. 不提交 `.env`，新增配置项要同步写进 `.env.example`。
6. 交接记录写在 `../docs/TASKS.md`，注明「server 项目」和提交号。
7. 应用配置统一写在 `src/app.setup.ts`（`main.ts`、端到端测试、接口文档导出共用），不要只改 `main.ts`。
8. 读配置用 `AppConfigService`，不要在业务代码里直接读 `process.env`；新增环境变量先加到 `src/core/config/env.validation.ts` 做启动校验。
9. 业务错误抛 `BusinessException`，错误码统一维护在 `src/core/exceptions/error-code.ts`。
10. 普通增删改查模块用 `@CrudController` + `BaseController`（`src/core/crud/`），业务字段用 `@CrudField` 声明，可写字段必须写 class-validator 校验；需要钩子时继承 `BaseService` 并放进模块 providers。自定义接口查数据用 `BaseService` 的 `select()`，**禁止**直接用 Repository 绕开租户和数据范围条件。
11. 端到端测试连真实 MySQL 的测试库 `<DB_NAME>_test`（`deploy/docker-compose.yml` 首次启动时自动建好），测试会清空这个库，绝不能指向开发库或生产库。
12. 唯一约束必须带租户：`@Index('uk_表_字段', ['tenantId', '业务字段', 'activeGuard'], { unique: true })`；软删除的表必须带 `activeGuard`，硬删除的表可以不带。写错启动时会报错。
13. 控制器必须属于一个端：用 `@AdminController('模块/资源')`（以后还有 `@AppController`、`@WebController`、`@OpenController`），放在 `controller/{admin,app,web,open}/` 下；不需要身份的基础接口（健康检查）才用 `@Public()`，而且不能放在各端前缀下。写错启动时报错。
14. 租户和当前用户只从请求上下文取（`RequestContext` / `CrudContextProvider`），由端的认证守卫写入，**禁止**从请求体、请求头自行读取。后台任务、消息消费、脚本用 `RequestContext.run({ tenantId }, fn)` 指定租户，没有上下文时读写会直接报错。
15. 不走通用 CRUD 的实体用 `TenantRepositoryFactory.for(实体)` 读写，自动带租户；**禁止**直接用 TypeORM 的 Repository、manager 或原生 SQL 改业务表。跨租户查询只能用在平台管理员接口上（`@IgnoreTenant()`），而且只能读。
