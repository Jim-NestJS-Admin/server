import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../core/exceptions/error-code.js';

/** 对象名只能由服务端生成；任何存储适配器都不能接受任意路径或 URL。 */
export const BLOB_KEY =
  /^tenants\/(?:0|[1-9]\d{0,19})\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp|pdf)$/;
export function assertBlobKey(key: string): void {
  if (!BLOB_KEY.test(key)) throw new Error('文件对象名无效');
}
export abstract class BlobStore {
  abstract put(key: string, data: Buffer, mime: string): Promise<void>;
  abstract get(key: string, maxBytes: number): Promise<Buffer>;
  /** 只用于上传失败后的清理，不开放为公共删除接口。 */
  abstract discard(key: string): Promise<void>;
}

/** 对下载流同样限量，不能因为存储中的对象被替换而无限读取。 */
export async function boundedBuffer(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of stream) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    if (size > maxBytes)
      throw new BusinessException(
        ErrorCode.PayloadTooLarge,
        '文件超过大小限制',
        413,
      );
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
