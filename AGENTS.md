# AGENTS.md（server 项目）

本项目是 jim-nestjs-admin 的**后端**，独立 git 仓库。前端是旁边的 `../admin/`，另一个独立仓库；设计文档在 `../docs/`。

**开始任何工作之前，必须先读完 `../docs/AGENTS.md`（总规则）**，以及 `../docs/ARCHITECTURE.md`、`../docs/TASKS.md`。本文件只写后端项目的补充规则，和总规则冲突时以总规则为准。

## 后端补充规则

1. 技术栈以本项目 `package.json` 为准：NestJS 12、TypeScript、ES 模块（`"type": "module"`，源码里相对导入要写 `.js` 后缀）、oxlint、Prettier、vitest。
2. 提交前必须通过：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:e2e`、`pnpm build`、`pnpm format:check`。
3. 分支：Claude 用 `claude/<任务编号>-<简述>`，Codex 用 `codex/<任务编号>-<简述>`。任务同时改前后端时，`../admin/` 用同名分支。
4. 改了接口必须重新导出接口文档并提交（命令在 T02 落地后补到这里），前端据此生成代码。
5. 不提交 `.env`，新增配置项要同步写进 `.env.example`。
6. 交接记录写在 `../docs/TASKS.md`，注明「server 项目」和提交号。
