# 参与贡献

感谢你愿意参与 jim-nestjs-admin！

## 提交 Issue

- 报 Bug：说明运行环境（Node、MySQL、Redis 版本）、复现步骤、期望结果和实际结果
- 提需求：说明使用场景，以及为什么现有功能不能满足

## 提交 Pull Request

1. Fork 本仓库，从 `main` 新建分支
2. 按「快速开始」搭好本地环境
3. 修改代码，并补充相应测试
4. 提交前确保以下命令全部通过：

   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm test:e2e
   pnpm build
   pnpm format:check
   ```

5. 改了接口的话运行 `pnpm openapi:export`，并把 `openapi/admin.json` 一起提交
6. 提交 PR，说明改了什么、为什么改

## 代码约定

- 表名、列名使用小写下划线；bigint 一律按字符串返回
- 新的业务资源优先使用 `@CrudController`，不要绕过租户、数据权限和字段权限
- 不要提交 `.env`、密钥或真实数据
