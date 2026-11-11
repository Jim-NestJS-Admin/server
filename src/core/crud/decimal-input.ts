import { Transform } from 'class-transformer';
import { registerDecorator, type ValidationError } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { getMetadataArgsStorage } from 'typeorm';
import type { Type } from '@nestjs/common';
import type { CrudFieldMeta } from './crud-field.decorator.js';

interface DecimalRule {
  label: string;
  precision: number;
  scale: number;
}
const RULE = Symbol('crud:decimal-input');

/** 数字输入转十进制文本；不接受已失去整数精度的 JS number，也不把空字符串/布尔值当金额。 */
export function decimalText(value: unknown): unknown {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (Number.isInteger(value) && !Number.isSafeInteger(value))
  )
    return value;
  const text = String(value);
  if (!/e/i.test(text)) return text;
  const [coefficient, exponent] = text.toLowerCase().split('e');
  const negative = coefficient.startsWith('-');
  const [whole, fraction = ''] = coefficient.replace(/^-/, '').split('.');
  const digits = whole + fraction,
    point = whole.length + Number(exponent);
  const expanded =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (negative ? '-' : '') + expanded;
}

const pattern = (rule: DecimalRule) =>
  new RegExp(
    `^-?${rule.precision === rule.scale ? '0' : `\\d{1,${rule.precision - rule.scale}}`}${rule.scale ? `(\\.\\d{1,${rule.scale}})?` : ''}$`,
  );
const message = (rule: DecimalRule, value?: unknown) =>
  value == null
    ? `${rule.label}不能为空`
    : typeof value === 'number' &&
        Number.isInteger(value) &&
        !Number.isSafeInteger(value)
      ? `${rule.label}大整数请以字符串提交，避免精度丢失`
      : `${rule.label}最多 ${rule.precision - rule.scale} 位整数${rule.scale ? `、${rule.scale} 位小数` : '，不能有小数'}`;

/** 新生成的实体使用此装饰器；读取仍由 TypeORM 保持 decimal 字符串。 */
export function DecimalInput(rule: DecimalRule): PropertyDecorator {
  if (
    !Number.isInteger(rule.precision) ||
    !Number.isInteger(rule.scale) ||
    rule.precision < 1 ||
    rule.precision > 65 ||
    rule.scale < 0 ||
    rule.scale > 30 ||
    rule.scale > rule.precision
  )
    throw new Error('DECIMAL 精度配置不合法');
  return (target, property) => {
    Reflect.defineMetadata(RULE, rule, target, property);
    Transform(({ value }: { value: unknown }) => decimalText(value), {
      toClassOnly: true,
    })(target, property);
    registerDecorator({
      name: 'decimalInput',
      target: target.constructor,
      propertyName: String(property),
      constraints: [rule],
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && pattern(rule).test(value),
        defaultMessage: (args) => message(rule, args?.value),
      },
    });
  };
}

/** 按列元数据兼容已有手写/旧生成实体，不丢弃它们原有的业务校验。 */
export function applyDecimalInputs(
  dto: Type,
  entity: Type,
  properties: string[],
  fields: CrudFieldMeta[],
): void {
  for (const property of properties) {
    let options;
    for (
      let current: Function | null = entity;
      current && current !== Function.prototype;
      current = Object.getPrototypeOf(current) as Function | null
    ) {
      options = getMetadataArgsStorage().columns.find(
        (column) =>
          column.target === current && column.propertyName === property,
      )?.options;
      if (options) break;
    }
    if (
      !options ||
      !['decimal', 'numeric', 'dec', 'fixed'].includes(String(options.type))
    )
      continue;
    const rule = {
      label:
        fields.find((field) => field.property === property)?.label ?? property,
      precision: options.precision ?? 10,
      scale: options.scale ?? 0,
    };
    DecimalInput(rule)(dto.prototype, property);
    ApiProperty({
      oneOf: [
        { type: 'string', pattern: pattern(rule).source },
        { type: 'number' },
      ],
      description: message(rule, ''),
      nullable: !!options.nullable,
    })(dto.prototype, property);
  }
}

export function decimalRule(
  target: object | undefined,
  property: string,
): DecimalRule | undefined {
  return target
    ? (Reflect.getMetadata(RULE, target, property) as DecimalRule | undefined)
    : undefined;
}

/** 旧实体的默认英文 Matches/IsString 错误本地化；保留其自定义中文业务错误。 */
export function validationMessages(error: ValidationError): string[] {
  const rule = decimalRule(error.target as object | undefined, error.property);
  return [
    ...new Set(
      Object.entries(error.constraints ?? {}).map(([key, text]) =>
        rule &&
        ['matches', 'isString', 'decimalInput'].includes(key) &&
        (key === 'decimalInput' || !/[\u4e00-\u9fff]/.test(text))
          ? message(rule, error.value as unknown)
          : text,
      ),
    ),
  ];
}
