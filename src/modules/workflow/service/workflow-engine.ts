import { Engine, type BpmnEngineExecutionState } from 'bpmn-engine';
import { setImmediate } from 'node:timers/promises';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import type { WorkflowDesignerDto } from '../dto/workflow.dto.js';
import { compileWorkflow } from './workflow-rules.js';
import {
  runtimeNodes,
  previousApprovals,
  matchesCondition,
} from './workflow-plan.js';

export interface WorkflowWait {
  nodeId: string;
  executionId: string;
  index: number;
}
export interface WorkflowAdvance {
  state: BpmnEngineExecutionState;
  waits: WorkflowWait[];
  ended: boolean;
  automatic: {
    nodeId: string;
    executionId: string;
    index: number;
    actorId: string | null;
    reason: 'empty_pass' | 'repeat_pass';
  }[];
  entered: string[];
  copies: { nodeId: string; executionId: string }[];
  decisions: Record<string, string>;
}
interface ActivityApi {
  id: string;
  type: string;
  executionId: string;
  content: { index?: number; isMultiInstance?: boolean; isRootScope?: boolean };
  getExecuting(): ActivityApi[];
}

/** 引擎只在当前事务推进期间驻留内存；从数据库快照恢复，不依赖进程内实例缓存。 */
export async function advanceWorkflow(input: {
  code: string;
  revision: number;
  designer: WorkflowDesignerDto;
  bpmn: string;
  digest: string;
  compilerVersion: number;
  actors: Record<string, string[]>;
  values: Record<string, unknown>;
  applicantOrgId: string | null;
  applicantRoles: string[];
  approvedBy: Record<string, string[]>;
  decisions: Record<string, string>;
  state?: BpmnEngineExecutionState;
  signal?: WorkflowWait;
}): Promise<WorkflowAdvance> {
  const nodes = runtimeNodes(input.designer);
  const expected = compileWorkflow(
    input.designer,
    `wf_${input.code}_v${input.revision}`,
  );
  if (
    input.compilerVersion !== 1 ||
    expected.bpmn !== input.bpmn ||
    expected.digest !== input.digest
  )
    throw crudErrors.badRequest('实例流程快照校验失败，不能推进');
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const entered = new Set<string>();
  const copies: WorkflowAdvance['copies'] = [];
  let engineError: unknown;
  let policyFailure: ReturnType<typeof crudErrors.badRequest> | undefined;
  const engine = new Engine({
    name: `wf_${input.code}_v${input.revision}`,
    source: input.bpmn,
    disableDummyScript: true,
    // 不使用引擎默认的字符串求值器，只解释服务端编译器产生的两个固定模板。
    expressions: {
      resolveExpression(expression: string, context: unknown) {
        const count =
          /^\$\{environment\.services\.workflowApproverCount\("([A-Za-z][A-Za-z0-9_]{0,47})"\)\}$/.exec(
            expression,
          );
        if (count && nodeMap.has(count[1]!)) {
          entered.add(count[1]!);
          const actors = input.actors[count[1]!];
          if (!actors?.length && nodeMap.get(count[1]!)?.empty !== 'pass') {
            policyFailure = crudErrors.badRequest(
              `“${nodeMap.get(count[1]!)!.name}”没有可用办理人，请联系管理员`,
            );
            throw policyFailure;
          }
          if (!actors) throw new Error('缺少固定办理人快照');
          // 引擎不接受零基数顺序循环，空人通过用一项内部信号完成，不创建人工待办。
          return Math.max(actors.length, 1);
        }
        const any =
          /^\$\{environment\.services\.workflowAnyApproved\("([A-Za-z][A-Za-z0-9_]{0,47})", content\)\}$/.exec(
            expression,
          );
        if (any && nodeMap.get(any[1]!)?.mode === 'any') {
          const message = context as {
            content?: { output?: { approved?: unknown } };
          };
          return message.content?.output?.approved === true;
        }
        const branch =
          /^\$\{environment\.services\.workflowBranch\("([A-Za-z][A-Za-z0-9_]{0,47})","([A-Za-z][A-Za-z0-9_]{0,47})"\)\}$/.exec(
            expression,
          );
        if (branch) {
          const node = nodeMap.get(branch[1]!);
          if (node?.type !== 'condition') throw new Error('条件节点不存在');
          const selected = Object.hasOwn(input.decisions, node.id)
            ? node.branches!.find((b) => b.id === input.decisions[node.id])
            : node.branches!.find(
                (b) =>
                  b.default ||
                  matchesCondition(
                    b.condition!,
                    input.values,
                    input.applicantOrgId,
                    input.applicantRoles,
                  ),
              );
          if (!selected) throw new Error('流程条件缺少匹配或默认分支');
          input.decisions[node.id] = selected.id;
          return selected?.id === branch[2];
        }
        if (expression === '${environment.services.workflowCopy}')
          return (
            scope: { id: string; content: { executionId: string } },
            done: (error: Error | null, output?: object) => void,
          ) => {
            const nodeId = scope.id.slice('node_'.length);
            if (nodeMap.get(nodeId)?.type !== 'copy')
              return done(new Error('抄送节点不合法'));
            entered.add(nodeId);
            copies.push({ nodeId, executionId: scope.content.executionId });
            done(null, {});
          };
        throw new Error('流程包含非白名单表达式');
      },
    },
    scripts: {
      register() {
        return undefined;
      },
      getScript() {
        throw new Error('审批执行禁止脚本');
      },
    },
  });
  engine.on('error', (error: unknown) => {
    engineError = error;
  });
  try {
    if (input.state) engine.recover(input.state);
    const execution = input.state
      ? await engine.resume()
      : await engine.execute();
    const waits = () => {
      const result = new Map<string, WorkflowWait>();
      const visit = (api: ActivityApi) => {
        if (api.type !== 'bpmn:UserTask') return;
        const index = api.content.index;
        if (api.content.isMultiInstance && Number.isInteger(index)) {
          const nodeId = api.id.slice('node_'.length);
          if (
            !nodeMap.has(nodeId) ||
            !input.actors[nodeId] ||
            index! < 0 ||
            index! >= Math.max(input.actors[nodeId]!.length, 1)
          )
            throw new Error('引擎待办与办理人快照不一致');
          result.set(api.executionId, {
            nodeId,
            executionId: api.executionId,
            index: index!,
          });
        } else {
          for (const child of api.getExecuting()) visit(child);
        }
      };
      for (const api of execution.getPostponed())
        visit(api as unknown as ActivityApi);
      return [...result.values()];
    };
    const settle = async () => {
      // 让引擎的微任务完成，等待有界；不能用固定延迟猜测推进已完成。
      const deadline = Date.now() + 3000;
      while (
        !engineError &&
        execution.activityStatus === 'executing' &&
        Date.now() < deadline
      )
        await setImmediate();
      if (engineError) throw engineError;
      if (execution.activityStatus === 'executing')
        throw new Error('流程推进超时');
    };
    await settle();
    if (input.signal) {
      if (
        !waits().some(
          (w) =>
            w.nodeId === input.signal!.nodeId &&
            w.executionId === input.signal!.executionId &&
            w.index === input.signal!.index,
        )
      )
        throw crudErrors.versionConflict();
      execution.signal({
        id: `node_${input.signal.nodeId}`,
        executionId: input.signal.executionId,
        approved: true,
      });
      await settle();
    }
    const automatic: WorkflowAdvance['automatic'] = [];
    for (let step = 0; step <= 2200; step++) {
      const auto = waits().find((w) => {
        if (!input.actors[w.nodeId]!.length) return true;
        const prev =
          previousApprovals(input.designer, input.decisions).get(w.nodeId) ??
          [];
        return (
          nodeMap.get(w.nodeId)?.skipRepeated &&
          prev.length > 0 &&
          prev.every((id) =>
            input.approvedBy[id]?.includes(input.actors[w.nodeId]![w.index]!),
          )
        );
      });
      if (!auto) break;
      if (step === 2200) throw new Error('自动处理节点超过限制');
      const actorId = input.actors[auto.nodeId]![auto.index] ?? null;
      execution.signal({
        id: `node_${auto.nodeId}`,
        executionId: auto.executionId,
        approved: true,
      });
      automatic.push({
        nodeId: auto.nodeId,
        executionId: auto.executionId,
        index: auto.index,
        actorId,
        reason: actorId ? 'repeat_pass' : 'empty_pass',
      });
      if (actorId) (input.approvedBy[auto.nodeId] ??= []).push(actorId);
      await settle();
    }
    const postponed = waits();
    const ended = execution.state === 'idle';
    if (!ended && postponed.length === 0)
      throw new Error('流程未结束且没有可持久化待办');
    const state = await engine.getState();
    if (Buffer.byteLength(JSON.stringify(state)) > 2 * 1024 * 1024)
      throw crudErrors.badRequest('流程引擎快照超过2MiB限制');
    return {
      state,
      waits: postponed,
      ended,
      automatic,
      entered: [...entered],
      copies,
      decisions: input.decisions,
    };
  } catch (error) {
    throw policyFailure ?? error;
  } finally {
    await engine.stop();
  }
}
