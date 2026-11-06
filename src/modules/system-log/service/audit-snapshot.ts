/** 只移除凭据，不把HTTP请求体或请求头写入日志。内部删除快照也先经过此过滤。 */
export function auditSnapshot(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new Error('审计快照嵌套过深，拒绝删除');
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return value.map((item) => auditSnapshot(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /(password|token|secret|authorization|cookie|credential|private.?key)/i.test(
        key,
      )
        ? '[已隐去]'
        : auditSnapshot(item, depth + 1),
    ]),
  );
}
