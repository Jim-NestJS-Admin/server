import { AsyncLocalStorage } from 'node:async_hooks';
import type { ContextSnapshot } from '../tenant/request-context.js';

const PARTICIPANTS = 'jna:participants';
/** 参与人资源按本人参与关系授权，仍受租户、接口和字段权限保护，不继承组织的批量可见范围。 */
export function ParticipantResource(field: string): ClassDecorator {
  if (!/^[a-z][A-Za-z0-9]*$/.test(field)) throw new Error('参与人字段无效');
  return (target) => {
    Reflect.defineMetadata(PARTICIPANTS, field, target);
  };
}
export function participantField(entity: Function): string | undefined {
  return Reflect.getMetadata(PARTICIPANTS, entity) as string | undefined;
}
interface Grant {
  tenantId: string;
  userId: string | null;
  resource: string;
  id: string;
}
const documents = new AsyncLocalStorage<Grant>();
/** 只能在服务端核实待办/参与关系后调用；授权只在回调内生效，不改会话/角色/全局AuthzContext。 */
export function withDocumentAccess<T>(
  ctx: ContextSnapshot,
  resource: string,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (ctx.ignoreTenant) throw new Error('跨租户模式不能签发单据授权');
  return documents.run(
    { tenantId: ctx.tenantId, userId: ctx.userId, resource, id },
    fn,
  );
}
export function documentAccess(
  ctx: { tenantId: string; userId: string | null },
  resource: string,
): string | undefined {
  const grant = documents.getStore();
  return grant?.tenantId === ctx.tenantId &&
    grant.userId === ctx.userId &&
    grant.resource === resource
    ? grant.id
    : undefined;
}
