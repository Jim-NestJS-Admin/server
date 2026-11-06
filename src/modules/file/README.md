# T09 文件模块 · 独立部分

本批在 `codex/T09-file-module`，基于已通过的 T03①② `133a76f`，只修改 `modules/file` 和必要依赖。包含实际内容检测、本地/OSS/S3 适配器、鉴权前置 multipart 上传、私有附件下载与失败补偿。**未注册到正式 AppModule，T09 整体仍在进行中**。

## 已实现

- `file-type` 从文件实际内容识别类型，不信任客户端 MIME/扩展名。策略只能收窄 PNG/JPEG/WebP/PDF，单文件配置上限最大20 MiB；HTTP解析层和服务层都限制大小，下载流也限量。类型探测是签名识别，不是病毒扫描或完整文件格式校验。
- 系统生成 `tenants/<可信租户>/<UUID>.<检测到的扩展名>`，不使用客户端名称，不接受存储路径、URL、桶或 endpoint 入参。适配器逐一校验对象名；本地对象禁止覆盖、限制文件权限、拒绝目录链接与文件链接，必须放私有非静态目录。
- OSS/S3 使用官方 SDK，不自行实现签名；OSS 上传显式 private，两个适配器都禁止覆盖。S3 **必须**配置私有桶和 Block Public Access，IAM 仅授权指定桶/前缀；本批没有访问真实云或验证你的云权限。SDK客户端由管理员配置，并应设置网络超时和有限重试，不能从用户请求创建客户端。
- Guard 在 multipart 解析器前执行，默认拒绝。下载先查询有范围约束的元数据，再二次检查对象租户前缀，跨租户/不存在同404，拒绝时不读取存储；下载检查大小和SHA256，强制 attachment / application/octet-stream / nosniff / private,no-store，不生成公网直链。
- 对象写入后元数据保存失败会清理刚写的对象；清理失败只写固定维护提示，不把SDK错误/凭据/文件内容写日志。对象存储与SQL不构成同一个事务：进程崩溃仍可能留下孤立对象，正式接入需维护清理任务，不能把补偿描述为完全原子。

### S3 兼容性要求

S3 适配器通过 `PutObject` 的 `IfNoneMatch: '*'` 条件写入防止覆盖。部署到兼容 S3 的服务前，必须确认该服务和版本支持此条件；不支持时上传会失败，不会降级为允许覆盖的无条件写入。本批只验证了 SDK 命令参数，未验证真实云服务兼容性。

上传目前整份缓存在内存中，单文件最多20 MiB；全局请求体上限与上传并发限制待 T25 统一接入。

## 待接入的正式接口

`FileModule.register` 可在装配时传入存储和策略；不读 process.env，不新增绕过启动校验的环境变量。

- `FileAccess.current('upload'|'read')`：由 T05/T06 的 core 适配器每次核对后台会话、当前组织和 `file:asset:upload` / `file:asset:read`，返回可信租户/用户（字符串编号）。默认 DenyFileAccess 返回401，不能用未验证JWT或请求体身份代替。
- `FileCatalog.ready/insert/find`：待 T04 稳定后由本模块的 BaseService 子类实现数据库持久化。新增实体继承 BaseEntity，附 migration；查询通过 core 的当前上下文/范围，插入由 core 填租户/审计字段。接口不接受 tenantId 参数。默认 UnconfiguredFileCatalog 返回503，在写存储之前拒绝；**没有生产内存替身、默认租户回退**。
- T25：统一上传限流、幂等入口和维护任务；T09 不另开跳过这些要求的通道。
- 正式配置接 AppConfigService + 启动校验，AppModule 注册、正式 OpenAPI 导出和 T12 生成客户端；按部署规定将上传内容放独立存储域/私有桶，不作为后台同源可执行静态资源。

上述接入完成前不开放正式接口、不标记整体验收通过。本批没有新建实体/表，不生成虚假的迁移或操作真实用户数据。不能用测试中的内存 Catalog 作为正式实现。

## 独立测试应用中的接口契约

| 路径                            | 请求                                | 结果                                                                            |
| ------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| POST /admin/file/asset/upload   | multipart/form-data，仅 `file` 一项 | `{code:1000,data:{id,name,mime,bytes},message}`，不返回对象key/原名称/云SDK URL |
| POST /admin/file/asset/download | `{id:string}`，其他字段拒绝         | 原始二进制附件；错误仍是统一中文响应                                            |

OpenAPI 带 operationId、multipart binary、下载binary响应及 `x-permissions`。真实认证尚未装配，此处是后端可测试契约，不表示正式应用已开放或通过联调。导出正式 admin.json 没有这些端点是因为模块未注册；没有把测试接口混进正式客户端。

## 依赖与验证

新增运行依赖 `file-type`（内容识别）、`@aws-sdk/client-s3`、`ali-oss`（官方云SDK）；开发类型 `@types/ali-oss`、`@types/multer`（云客户端和Nest上传参数类型），不自写识别或签名逻辑。参考 [Nest上传](https://docs.nestjs.com/techniques/file-upload)、[file-type](https://github.com/sindresorhus/file-type)、[AWS SDK](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/getting-started-nodejs.html)、[OSS SDK](https://github.com/ali-sdk/ali-oss)。

`file.spec.ts` 的20项新增测试：内容识别/拒绝脚本与截断/大小/路径，本地读写/覆盖/链接边界，两个云SDK命令替身，真实 Nest HTTP 上传与下载、跨租户404且不读存储、额外字段/超大文件、元数据失败清理、OpenAPI、未配认证401/未配Catalog503。加既有46项，共66项。HTTP测试仅用合成文件/内存Catalog，云SDK不联网；这不能替代真实租户数据库隔离和云访问策略验收。

本机 lint/类型/66测试/build/格式/OpenAPI 导出通过；本地真实 MySQL/Redis e2e 未跑，正式 Catalog 与认证装配后的数据库端到端测试仍必须补齐。生产依赖审计结果见 TASKS 交接，不将未运行的云/数据库验证说成通过。
