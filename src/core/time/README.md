# 系统时区目录

`timeZoneCatalog()`提供服务端运行时支持的IANA主要标识，并补充UTC；当前Node/ICU环境为419项。目录在内存中只读维护，不进入可停用或由租户覆盖的业务字典。常用项靠前，中英文名称供选择器搜索，保存值始终为IANA标识。

中文城市名派生自[Unicode CLDR 48.0.0](https://github.com/unicode-org/cldr-json/tree/48.0.0/cldr-json/cldr-dates-full/main/zh)，许可证位于third-party/UNICODE-LICENSE.txt；生成的数据模块也保留许可证，编译后的模块可随应用一起分发。目录标识由Intl.supportedValuesOf('timeZone')决定，更新Node/ICU可能改变候选集；旧值不会被自动重写。新增或真正改变时区时使用canonicalTimeZone规范别名并拒绝固定偏移等非目录值。

维护时在server目录运行`node scripts/update-timezone-cities.mjs`，下载固定版本CLDR、提取城市名并更新许可证，随后运行Prettier和时区测试。运行时不联网，不新增npm依赖；将来升级CLDR时需明确修改脚本中的版本并复核许可证和别名测试。

规则的日期运算独立使用Intl.DateTimeFormat及保存的时区，遵守夏令时。元数据修改不因旧值缺少目录项而失败；旧值仍由实际计算的运行时能力决定能否执行。界面加载失败显示错误和重试，不替换用户值。
