import type { CrudSchemaColumn } from './crud-schema.js';
import type { DictItem } from './crud-field.decorator.js';

/** 输入必须是已经过逐行权限裁剪的行；脱敏值不能再查字典或显示名。 */
export function exportValue(
  row: Record<string, unknown>,
  column: CrudSchemaColumn,
  dictionary?: DictItem[],
  timeZone?: string,
): unknown {
  const value = row[column.field];
  const state = (row._fieldState as Record<string, string> | undefined)?.[
    column.field
  ];
  if (!Object.hasOwn(row, column.field) || state === 'hidden') return '';
  if (state === 'masked' || value == null) return value ?? '';
  const named = (row._display as Record<string, string> | undefined)?.[
    column.field
  ];
  if (named) return named;
  const option = dictionary?.find(
    (item) =>
      ['string', 'number', 'boolean'].includes(typeof value) &&
      String(item.value) === String(value as string | number | boolean),
  );
  if (option) return option.label;
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (
    column.type === 'date' &&
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value)
  )
    return value;
  if (
    (column.type === 'datetime' || column.type === 'date') &&
    (typeof value === 'string' || value instanceof Date)
  ) {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return value;
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const part = (type: string) => parts.find((p) => p.type === type)?.value;
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    return column.type === 'date'
      ? day
      : `${day} ${part('hour')}:${part('minute')}:${part('second')}`;
  }
  return value;
}
