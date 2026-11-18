import type { McpOperation } from '../entity/mcp.entity.js';

/** 列表和确认回执共用有效状态；读取过期状态不写数据库。 */
export function effectiveOperationStatus(
  row: Pick<McpOperation, 'status' | 'expiresAt'>,
) {
  return row.status === 'pending' && row.expiresAt.getTime() <= Date.now()
    ? 'expired'
    : row.status;
}
