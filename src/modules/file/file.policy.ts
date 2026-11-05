import { fileTypeFromBuffer } from 'file-type';
import { BusinessException } from '../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../core/exceptions/error-code.js';
export const FILE_POLICY = Symbol('file:policy');
const ALLOWED = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
]);
export interface FilePolicy {
  maxBytes: number;
  mimeTypes: readonly string[];
}
export function validateFilePolicy(value: FilePolicy): FilePolicy {
  if (
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes < 1 ||
    value.maxBytes > 20 * 1024 * 1024 ||
    !value.mimeTypes.length ||
    value.mimeTypes.some((mime) => !ALLOWED.has(mime))
  )
    throw new Error(
      '上传策略无效：上限 20 MiB，仅允许 PNG/JPEG/WebP/PDF 白名单',
    );
  return Object.freeze({
    maxBytes: value.maxBytes,
    mimeTypes: Object.freeze([...new Set(value.mimeTypes)]),
  });
}
export async function inspectFile(
  data: Buffer,
  policy: FilePolicy,
): Promise<{ mime: string; ext: string }> {
  if (!data.length)
    throw new BusinessException(ErrorCode.BadRequest, '请选择非空文件');
  if (data.length > policy.maxBytes)
    throw new BusinessException(
      ErrorCode.PayloadTooLarge,
      '文件超过大小限制',
      413,
    );
  let detected;
  try {
    detected = await fileTypeFromBuffer(data);
  } catch {
    /* 截断或损坏的文件同样拒绝。 */
  }
  if (!detected || !policy.mimeTypes.includes(detected.mime))
    throw new BusinessException(
      ErrorCode.BadRequest,
      '文件实际类型不在允许范围内',
    );
  return detected;
}
