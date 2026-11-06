/** 平台方租户：管理租户、套餐、全局菜单（架构「多租户设计 · 平台与租户两级」） */
export const PLATFORM_TENANT_ID = '0';
/** 阶段 1 只有一个业务租户；登录（T05）之前后台请求都落在这个租户 */
export const DEFAULT_TENANT_ID = '1';
export const TENANT_ID_PATTERN = /^(0|[1-9]\d{0,19})$/;
