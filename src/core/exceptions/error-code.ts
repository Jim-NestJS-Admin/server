/**
 * 统一响应里的 code。1000 表示成功；4xxx 对应客户端错误，5xxx 对应服务端错误。
 * 业务模块需要更细的错误码时，在 10000 以上按模块分段（例如 system 用 11xxx），并加在这里统一维护。
 */
export enum ErrorCode {
  Ok = 1000,
  BadRequest = 4000,
  Unauthorized = 4001,
  Forbidden = 4003,
  NotFound = 4004,
  Conflict = 4009,
  PayloadTooLarge = 4013,
  TooManyRequests = 4029,
  Internal = 5000,
  ServiceUnavailable = 5003,
}

export const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.Ok]: 'ok',
  [ErrorCode.BadRequest]: '请求参数有误',
  [ErrorCode.Unauthorized]: '请先登录',
  [ErrorCode.Forbidden]: '没有权限',
  [ErrorCode.NotFound]: '资源不存在',
  [ErrorCode.Conflict]: '数据冲突，请刷新后重试',
  [ErrorCode.PayloadTooLarge]: '请求内容过大',
  [ErrorCode.TooManyRequests]: '请求太频繁，请稍后再试',
  [ErrorCode.Internal]: '服务器内部错误',
  [ErrorCode.ServiceUnavailable]: '服务暂不可用',
};

/** HTTP 状态码 → 统一错误码 */
export function codeFromStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 422:
      return ErrorCode.BadRequest;
    case 401:
      return ErrorCode.Unauthorized;
    case 403:
      return ErrorCode.Forbidden;
    case 404:
      return ErrorCode.NotFound;
    case 409:
      return ErrorCode.Conflict;
    case 413:
      return ErrorCode.PayloadTooLarge;
    case 429:
      return ErrorCode.TooManyRequests;
    case 503:
      return ErrorCode.ServiceUnavailable;
    default:
      return status >= 500 ? ErrorCode.Internal : ErrorCode.BadRequest;
  }
}
