/** 启用且祖先链完整、无环的组织，登录列表与角色分配共用同一个判断。 */
export function validOrganizations<
  T extends { id: string; parentId: string | null; enabled: boolean },
>(rows: T[]): T[] {
  const map = new Map(
    rows.filter((row) => row.enabled).map((row) => [row.id, row]),
  );
  return rows.filter((row) => {
    const seen = new Set<string>();
    let current: T | undefined = row;
    while (current) {
      if (!current.enabled || seen.has(current.id)) return false;
      seen.add(current.id);
      if (current.parentId && !map.has(current.parentId)) return false;
      current = current.parentId ? map.get(current.parentId) : undefined;
    }
    return true;
  });
}
