import { createHash } from 'node:crypto';
import type { FieldState, MaskRule } from './field-perm.decorator.js';
export interface DynamicFieldResource {
  resource: string;
  label: string;
  fields: {
    field: string;
    label: string;
    default: FieldState;
    mask: MaskRule | null;
    delegable: FieldState | null;
    configurable: boolean;
  }[];
}
/** 稳定资源键不依赖表单修订，兼容系统字段权限的权限前缀与长度约束。 */
export function dynamicFieldResource(namespace: string, key: string): string {
  return `${namespace}:dynamic-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}
