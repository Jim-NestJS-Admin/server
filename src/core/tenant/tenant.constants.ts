/** 平台方租户：管理租户、套餐、全局菜单（架构「多租户设计 · 平台与租户两级」） */
export const PLATFORM_TENANT_ID = '0';
/** 阶段 1 只有一个业务租户；登录（T05）之前后台请求都落在这个租户 */
export const DEFAULT_TENANT_ID = '1';
export const TENANT_ID_PATTERN = /^(0|[1-9]\d{0,19})$/;
/**
 * 找不到租户（编码错、已停用、已过期、域名与编码不符）时免登录接口落到这个编号：
 * 它永远不会被分配（自增编号到不了 uint64 上限），登录自然失败，提示与密码错误相同，不泄露租户是否存在。
 */
export const UNRESOLVED_TENANT_ID = '18446744073709551615';
/** 共用域名时前端在免登录接口（出题、登录、刷新、退出）上带租户编码的请求头 */
export const TENANT_CODE_HEADER = 'x-tenant-code';
