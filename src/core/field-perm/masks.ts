import type { MaskRule } from './field-perm.decorator.js';

export const MASK_RULES: { code: MaskRule; label: string }[] = [
  { code: 'phone', label: '手机号（138****5678）' },
  { code: 'email', label: '邮箱（a***@example.com）' },
  { code: 'idcard', label: '证件号（保留前 3 后 4）' },
  { code: 'last4', label: '只显示后 4 位' },
  { code: 'all', label: '全部打码' },
];

const keep = (s: string, head: number, tail: number) =>
  s.length <= head + tail
    ? '*'.repeat(s.length || 4)
    : s.slice(0, head) + '*'.repeat(s.length - head - tail) + s.slice(-tail);

/** 打码。null / undefined 原样返回（没有值就没有可泄露的） */
export function mask(
  value: unknown,
  rule: MaskRule | null | undefined,
): unknown {
  if (value === null || value === undefined) return value;
  const s =
    typeof value === 'object' ? JSON.stringify(value) : String(value as string);
  switch (rule) {
    case 'phone':
      return keep(s, 3, 4);
    case 'email': {
      const at = s.indexOf('@');
      return at > 0 ? s[0] + '***' + s.slice(at) : '****';
    }
    case 'idcard':
      return keep(s, 3, 4);
    case 'last4':
      return s.length > 4 ? '*'.repeat(4) + s.slice(-4) : '****';
    default:
      return '****';
  }
}
