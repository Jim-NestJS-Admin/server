import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE = 'core:raw-response';
/** 不包统一响应格式。只用于健康检查、文件下载、第三方回调应答这类必须原样返回的接口 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);
