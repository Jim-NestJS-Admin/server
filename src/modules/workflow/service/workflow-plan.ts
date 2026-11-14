import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { SystemDirectory } from '../../system/service/system-directory.service.js';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import type {
  WorkflowDesignerDto,
  WorkflowNode,
  WorkflowCondition,
} from '../dto/workflow.dto.js';

export function runtimeNodes(designer: WorkflowDesignerDto): WorkflowNode[] {
  return designer.nodes.flatMap((n) => [
    n,
    ...(n.branches?.flatMap((b) =>
      runtimeNodes({ schemaVersion: 1, nodes: b.nodes }),
    ) ?? []),
  ]);
}
export function matchesCondition(
  condition: WorkflowCondition,
  values: Record<string, unknown>,
  orgId: string | null,
  roleIds: string[],
): boolean {
  if ('logic' in condition)
    return condition.logic === 'all'
      ? condition.conditions.every((c) =>
          matchesCondition(c, values, orgId, roleIds),
        )
      : condition.conditions.some((c) =>
          matchesCondition(c, values, orgId, roleIds),
        );
  const left =
    condition.source === 'field'
      ? values[condition.field!]
      : condition.source === 'applicant_org'
        ? orgId
        : roleIds;
  const right = condition.value;
  const equal = (value: unknown) =>
    Array.isArray(left) ? left.includes(value) : left === value;
  switch (condition.operator) {
    case 'eq':
      return equal(right);
    case 'ne':
      return !equal(right);
    case 'in':
      return Array.isArray(right) && right.some(equal);
    case 'not_in':
      return Array.isArray(right) && !right.some(equal);
    default: {
      if (
        (typeof left !== 'number' && typeof left !== 'string') ||
        typeof left !== typeof right ||
        Array.isArray(right)
      )
        return false;
      if (condition.operator === 'gt') return left > (right as typeof left);
      if (condition.operator === 'gte') return left >= (right as typeof left);
      if (condition.operator === 'lt') return left < (right as typeof left);
      return left <= (right as typeof left);
    }
  }
}
/** 沿实际条件路径解析相邻审批节点；并行汇合时要求全部前序都已由该成员同意。 */
export function previousApprovals(
  designer: WorkflowDesignerDto,
  decisions: Record<string, string>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  function walk(nodes: WorkflowNode[], previous: string[]): string[] {
    for (const node of nodes) {
      if (node.type === 'approve') {
        result.set(node.id, previous);
        previous = [node.id];
      } else if (node.branches)
        previous = [
          ...new Set(
            node.branches
              .filter(
                (b) =>
                  node.type !== 'condition' ||
                  !Object.hasOwn(decisions, node.id) ||
                  b.id === decisions[node.id],
              )
              .flatMap((b) => walk(b.nodes, previous)),
          ),
        ];
    }
    return previous;
  }
  walk(designer.nodes, []);
  return result;
}

@Injectable()
export class WorkflowPlanner {
  constructor(private readonly directory: SystemDirectory) {}
  async plan(
    input: {
      designer: WorkflowDesignerDto;
      applicantId: string;
      applicantOrgId: string | null;
      selections: Record<string, string[]>;
      actors: Record<string, string[]>;
    },
    manager: EntityManager,
  ) {
    const nodes = runtimeNodes(input.designer);
    const selectable = new Set(
      nodes.filter((n) => n.actor?.type === 'self_select').map((n) => n.id),
    );
    if (Object.keys(input.selections).some((key) => !selectable.has(key)))
      throw crudErrors.badRequest('自选审批人只能填写流程声明的自选节点');
    for (const ids of Object.values(input.selections))
      if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > 50 ||
        ids.some(
          (id) => typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id),
        ) ||
        new Set(ids).size !== ids.length
      )
        throw crudErrors.badRequest('每个自选节点请选择1–50名不重复的有效成员');
    const actors: Record<string, string[]> = structuredClone(input.actors);
    for (const node of nodes) {
      if (!node.actor || Object.hasOwn(actors, node.id)) continue;
      const actor = node.actor;
      let ids: string[];
      if (
        actor.type === 'users' ||
        actor.type === 'applicant' ||
        actor.type === 'self_select'
      ) {
        const selected =
          actor.type === 'users'
            ? actor.ids!
            : actor.type === 'applicant'
              ? [input.applicantId]
              : input.selections[node.id];
        if (!selected)
          throw crudErrors.badRequest(`请为“${node.name}”选择办理人`);
        ids = await this.directory.workflowEnabledUsers(selected, manager);
        if (actor.type === 'self_select' && ids.length !== selected.length)
          throw crudErrors.badRequest(
            `“${node.name}”选择了已停用或不存在的成员`,
          );
      } else
        ids = await this.directory.workflowActors(
          actor.type,
          input.applicantId,
          input.applicantOrgId,
          actor.ids ?? [],
          actor.level ?? 1,
          manager,
        );
      if (ids.length === 0 && node.empty === 'administrator')
        ids = await this.directory.workflowActors(
          'administrator',
          input.applicantId,
          input.applicantOrgId,
          [],
          1,
          manager,
        );
      actors[node.id] = ids;
    }
    if (Object.values(actors).reduce((n, ids) => n + ids.length, 0) > 2000)
      throw crudErrors.badRequest('单个流程的办理人最多2000人次');
    return actors;
  }
}
