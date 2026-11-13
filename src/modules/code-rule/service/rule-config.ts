import { crudErrors } from '../../../core/crud/crud.errors.js';
import type { Type } from '@nestjs/common';
import type { BaseEntity } from '../../../core/crud/base.entity.js';

export const CODE_START_MESSAGE =
  '起始值必须为大于或等于1的整数，最多12位，不能以0开头。';

export type Segment =
  | { type: 'literal'; value: string }
  | { type: 'date'; format: string }
  | { type: 'timestamp'; unit: 'seconds' | 'milliseconds' }
  | { type: 'sequence'; width: number };
export interface RuleConfig {
  timezone: string;
  resetPeriod: string;
  segments: Segment[];
  start: string;
}
export interface CodeUsage {
  entity?: Type<BaseEntity>;
  key: string;
  name: string;
  resource: string;
  field: string;
  maxLength: number;
  minLength?: number;
  charset: 'upper_alnum' | 'lower_slug' | 'digits';
  mustStartWithLetter?: boolean;
  uniqueScope: 'tenant';
  allowRuleSwitch: boolean;
}
const formats = [
  'yyyy',
  'yyyyMM',
  'yyyy-MM',
  'yyyyMMdd',
  'yyyy-MM-dd',
  'yyyyMMddHHmmss',
  'yyyy-MM-dd_HH-mm-ss',
];
export function invalid(message: string, field = 'segments'): never {
  throw crudErrors.badRequest('编码规则不合法', [
    { field: `data.${field}`, messages: [message] },
  ]);
}
export function validateConfig(input: RuleConfig): RuleConfig {
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
  } catch {
    invalid('请选择有效时区', 'timezone');
  }
  if (!['never', 'year', 'month', 'day'].includes(input.resetPeriod))
    invalid('重置周期无效', 'resetPeriod');
  if (
    !Array.isArray(input.segments) ||
    input.segments.length < 1 ||
    input.segments.length > 4
  )
    invalid('请配置1至4个编码段');
  let dates = 0,
    timestamps = 0,
    sequences = 0,
    length = 0,
    width = 0;
  for (const [i, s] of input.segments.entries()) {
    if (!s || typeof s !== 'object') invalid('编码段必须是对象');
    const allowed =
      s.type === 'literal'
        ? ['type', 'value']
        : s.type === 'date'
          ? ['type', 'format']
          : s.type === 'timestamp'
            ? ['type', 'unit']
            : ['type', 'width'];
    if (Object.keys(s).some((k) => !allowed.includes(k)))
      invalid('编码段包含不支持的配置');
    if (s.type === 'literal') {
      if (typeof s.value !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(s.value))
        invalid('固定文本限1至16位字母、数字、下划线或短横线');
      length += s.value.length;
    } else if (s.type === 'date') {
      if (!formats.includes(s.format)) invalid('日期格式无效');
      dates++;
      length += s.format.length;
    } else if (s.type === 'timestamp') {
      if (!['seconds', 'milliseconds'].includes(s.unit))
        invalid('请选择秒或毫秒时间戳');
      timestamps++;
      // 以Date支持的非负时间范围预算长度，生成时仍按用途校验真实输出。
      length += s.unit === 'seconds' ? 13 : 16;
    } else if (s.type === 'sequence') {
      if (
        !Number.isInteger(s.width) ||
        s.width < 1 ||
        s.width > 12 ||
        i !== input.segments.length - 1
      )
        invalid('流水号必须放在最后，宽度1至12位');
      sequences++;
      width = s.width;
      length += width;
    } else invalid('不支持的编码段类型');
  }
  if (sequences !== 1 || dates > 1 || timestamps > 1 || length > 64)
    invalid('必须恰有一个流水段，最多一个日期和一个时间戳段，总长度不超过64');
  if (typeof input.start !== 'string' || !/^[1-9]\d{0,11}$/.test(input.start))
    invalid(CODE_START_MESSAGE, 'start');
  if (BigInt(input.start) >= 10n ** BigInt(width))
    invalid(
      `起始值不能超过${width}位流水号的最大值${10n ** BigInt(width) - 1n}。`,
      'start',
    );
  const date = input.segments.find((s) => s.type === 'date');
  const format = date?.type === 'date' ? date.format : '';
  if (
    input.resetPeriod !== 'never' &&
    (!format.includes('yyyy') ||
      (['month', 'day'].includes(input.resetPeriod) &&
        !format.includes('MM')) ||
      (input.resetPeriod === 'day' && !format.includes('dd')))
  )
    invalid('日期段必须完整包含重置周期，避免重号');
  return structuredClone(input);
}
export function dateParts(timezone: string, now: Date) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (key: string) => p.find((v) => v.type === key)!.value;
  return {
    yyyy: part('year'),
    MM: part('month'),
    dd: part('day'),
    HH: part('hour'),
    mm: part('minute'),
    ss: part('second'),
  };
}
export function periodKey(config: RuleConfig, now: Date) {
  const p = dateParts(config.timezone, now);
  return config.resetPeriod === 'never'
    ? 'all'
    : config.resetPeriod === 'year'
      ? p.yyyy
      : config.resetPeriod === 'month'
        ? `${p.yyyy}-${p.MM}`
        : `${p.yyyy}-${p.MM}-${p.dd}`;
}
export function renderCode(config: RuleConfig, value: bigint, now: Date) {
  const p = dateParts(config.timezone, now);
  return config.segments
    .map((s) =>
      s.type === 'literal'
        ? s.value
        : s.type === 'timestamp'
          ? String(
              s.unit === 'seconds'
                ? Math.floor(now.getTime() / 1000)
                : now.getTime(),
            )
          : s.type === 'sequence'
            ? value.toString().padStart(s.width, '0')
            : s.format
                .replace('yyyy', p.yyyy)
                .replace('MM', p.MM)
                .replace('dd', p.dd)
                .replace('HH', p.HH)
                .replace('mm', p.mm)
                .replace('ss', p.ss),
    )
    .join('');
}
export function maximum(config: RuleConfig) {
  const s = config.segments.find((s) => s.type === 'sequence');
  return 10n ** BigInt(s?.type === 'sequence' ? s.width : 0) - 1n;
}
export function compatible(config: RuleConfig, usage: CodeUsage) {
  validateConfig(config);
  const lengthBudget = config.segments.reduce(
    (n, s) =>
      n +
      (s.type === 'literal'
        ? s.value.length
        : s.type === 'date'
          ? s.format.length
          : s.type === 'sequence'
            ? s.width
            : s.unit === 'seconds'
              ? 13
              : 16),
    0,
  );
  if (lengthBudget > usage.maxLength)
    invalid(`规则与“${usage.name}”的最大长度不兼容`);
  for (const value of [BigInt(config.start), maximum(config)]) {
    const code = renderCode(config, value, new Date('2026-11-13T12:00:00Z'));
    const pattern =
      usage.charset === 'digits'
        ? /^\d+$/
        : usage.charset === 'lower_slug'
          ? /^[a-z][a-z0-9_]*$/
          : /^[A-Z0-9_-]+$/;
    if (
      !pattern.test(code) ||
      code.length > usage.maxLength ||
      code.length < (usage.minLength ?? 1) ||
      ((usage.mustStartWithLetter || usage.charset === 'lower_slug') &&
        !/^[A-Za-z]/.test(code))
    )
      invalid(`规则与“${usage.name}”的长度或字符格式不兼容`);
  }
}
export function validateOutput(code: string, usage: CodeUsage) {
  const pattern =
    usage.charset === 'digits'
      ? /^\d+$/
      : usage.charset === 'lower_slug'
        ? /^[a-z][a-z0-9_]*$/
        : /^[A-Z0-9_-]+$/;
  if (
    !pattern.test(code) ||
    code.length > usage.maxLength ||
    code.length < (usage.minLength ?? 1) ||
    (usage.mustStartWithLetter && !/^[A-Za-z]/.test(code))
  )
    invalid(`生成的编码与“${usage.name}”的长度或字符格式不兼容`);
}
