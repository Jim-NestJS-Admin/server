# jim-nestjs-admin-server

基于 **NestJS + TypeORM + MySQL** 的通用后台管理框架（后端）。写一次实体和配置，就能得到完整的增删改查接口、权限码、字段清单和页面描述；内置多租户、多级组织、数据权限、字段权限和代码生成器，适合作为企业后台项目的起点。

> 前端项目：[Jim-NestJS-Admin/admin](https://github.com/Jim-NestJS-Admin/admin)（Vue 3 + Element Plus，基于 Pure Admin）

## 功能特性

**通用 CRUD**
- `@CrudController` 按配置自动生成分页、详情、新增、修改、删除、导出接口和页面描述 `GET /admin/<资源>/schema`
- 乐观锁：两人同时编辑，后保存的人收到冲突提示，不会覆盖别人的修改
- 批量操作整批成功或整批不执行；钩子在事务里执行
- 软删除 / 硬删除可选，软删除带回收站（恢复、彻底删除）
- 主子表聚合保存：多个子表、增改删一次提交、同一事务
- 导出 CSV / Excel，与字段权限、逐行脱敏共用同一套规则，防公式注入

**权限体系**
- 菜单 / 按钮权限（RBAC），后端按权限码拦截
- 矩阵权限：同一个人在不同组织有不同角色
- 数据权限：全部 / 本组织 / 本组织及下级 / 仅本人 / 自定义
- 字段权限：每个字段对每个角色可设为可编辑、只读、脱敏、隐藏，后台配置保存即生效

**多租户与组织**
- 共享数据库 + `tenant_id` 隔离，查询自动带租户，写入有越租户保险
- 多级组织（集团 → 公司 → 部门 → 站点），用户可属多个组织、有多个上级

**系统管理**
- 用户、角色、组织、菜单、字典（平台系统字典 + 租户业务字典）、系统参数
- 操作日志、登录日志；文件上传（本地存储，预留 S3 / OSS 适配口）

**安全基线**
- 双令牌（短期访问 + 长期刷新），刷新令牌轮换防重放；改密、禁用、踢人立即失效
- 图形验证码、登录失败锁定、分级限流、幂等键防重复提交
- 结构化日志（Pino）自动隐去密码、令牌、密钥；启动时校验环境变量
- CI 检查依赖漏洞和密钥泄露（gitleaks）

**开发工具**
- 代码生成器（仅开发环境）：逐字段配置列表、查询、表单、字典、字段权限，选单表 / 树表 / 主子表模板，一次生成前后端代码
- 导出 OpenAPI，前端据此自动生成类型安全的接口代码

## 技术栈

| 类别 | 选型 |
| --- | --- |
| 框架 | NestJS 12、TypeScript |
| 数据库 | MySQL 8.4 + TypeORM |
| 缓存 | Redis |
| 日志 | Pino |
| 测试 | Vitest（单元 + 端到端） |
| 代码检查 | oxlint、Prettier |

## 快速开始

环境要求：Node.js 22+、pnpm 10（`corepack enable` 后自动使用）、Docker。

```bash
git clone https://github.com/Jim-NestJS-Admin/server.git
cd server
cp .env.example .env
```

编辑 `.env`：

- `DB_NAME` 改为 `jim_admin_local`（本地初始化脚本只允许这个库名）
- 修改 `DB_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`REDIS_PASSWORD`
- `AUTH_JWT_SECRET` 换成随机串：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
- `AUTH_ADMIN_ORIGINS` 填前端地址，默认前端为 `http://127.0.0.1:8851`

然后启动：

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d   # 启动 MySQL 和 Redis
pnpm install
pnpm bootstrap:local    # 执行迁移，初始化菜单、字典和管理员账号
pnpm start:dev          # 开发模式启动，默认端口 3000
```

- 接口文档：http://localhost:3000/docs （仅开发环境）
- 默认账号：`admin` / `123456`

> ⚠️ 默认账号只用于本机开发库。`bootstrap:local` 只允许在 development 环境、本机地址和 `jim_admin_local` 库上运行，**请勿用于生产环境**；生产部署前务必修改密码和所有密钥。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm start:dev` | 开发模式启动 |
| `pnpm build` / `pnpm start:prod` | 构建 / 运行构建结果 |
| `pnpm bootstrap:local` | 本地库迁移 + 初始化数据 |
| `pnpm migration:local` | 只执行迁移 |
| `pnpm menus:local` | 生成新模块后只补菜单 |
| `pnpm lint` / `pnpm typecheck` | 代码检查 / 类型检查 |
| `pnpm test` / `pnpm test:e2e` | 单元测试 / 端到端测试 |
| `pnpm openapi:export` | 导出接口文档到 `openapi/admin.json` |

端到端测试使用 `<DB_NAME>_test` 库并会清空它，**不要**让它指向开发库。compose 首次启动时会自动建好测试库；已有数据卷时需手动创建，详见 [docs/开发记录.md](docs/开发记录.md)。

## 目录结构

```
src/
├── core/          # 框架底座：crud、auth、permission、field-perm、tenant、security、logger……
├── modules/       # 业务模块：system（系统管理）、system-log、file、codegen
└── scripts/       # 本地初始化脚本
deploy/            # 本地 Docker 环境
openapi/           # 导出的接口文档
```

## 路线图

- [x] 阶段 1：系统底座（CRUD 框架、权限、组织、系统管理、代码生成器）
- [ ] 阶段 2：多租户（租户与套餐、平台 / 租户两级管理）
- [ ] 阶段 3：表单引擎与审批流、企业微信接入
- [ ] 阶段 4：CMS（多站点多语言内容）与会员
- [ ] 阶段 5：OAuth2 授权服务与 MCP（AI 按权限操作系统）
- [ ] 阶段 6：AI 能力（翻译、内容生成、SEO）

## 参与贡献

欢迎提交 Issue 和 Pull Request，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。发现安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[MIT](LICENSE) © 2026-present Jimmy
