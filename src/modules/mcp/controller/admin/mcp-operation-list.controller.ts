import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { Perms } from '../../../../core/permission/perms.decorator.js';
import { McpOperation } from '../../entity/mcp.entity.js';
import { McpOperationListService } from '../../service/mcp-operation-list.service.js';

/** 复用菜单既有准入码；仅覆盖三个只读接口，不开放写入。 */
const ExistingMcpAccess: ClassDecorator = (target) => {
  for (const method of ['schema', 'page', 'info']) {
    const descriptor = Object.getOwnPropertyDescriptor(
      target.prototype,
      method,
    );
    if (!descriptor) throw new Error(`MCP只读列表缺少${method}`);
    Perms('mcp:use')(target.prototype, method, descriptor);
  }
};

@ExistingMcpAccess
@CrudController({
  prefix: 'mcp/operation-list',
  label: 'MCP待确认操作',
  entity: McpOperation,
  service: McpOperationListService,
  api: ['page', 'info'],
  systemColumns: { id: '操作编号', createdAt: true },
  pageQuery: {
    keyWords: ['clientId', 'resource', 'action'],
    fieldEq: ['clientId', 'resource', 'action'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class McpOperationListController extends BaseController<McpOperation> {}
