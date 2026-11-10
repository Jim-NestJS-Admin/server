import { createHash } from 'node:crypto';
export const uniqueIndexName = (table: string, column: string) => {
  const name = `uk_${table}_${column}`;
  return name.length <= 64
    ? name
    : `${name.slice(0, 55)}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
};
export const sqlDefault = (value: unknown) =>
  value === null
    ? 'NULL'
    : typeof value === 'boolean'
      ? value
        ? '1'
        : '0'
      : typeof value === 'number'
        ? String(value)
        : `'${String(value as string)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "''")}'`;
