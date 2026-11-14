import { Engine, type BpmnEngineExecutionState } from 'bpmn-engine';
import { setImmediate } from 'node:timers/promises';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import type { WorkflowDesignerDto, WorkflowNode } from '../dto/workflow.dto.js';
import { compileWorkflow } from './workflow-rules.js';

export interface WorkflowWait {
  nodeId: string;
  executionId: string;
  index: number;
}
export interface WorkflowAdvance {
  state: BpmnEngineExecutionState;
  waits: WorkflowWait[];
  ended: boolean;
  emptyPassed: string[];
}
interface ActivityApi {
  id: string;
  type: string;
  executionId: string;
  content: { index?: number; isMultiInstance?: boolean; isRootScope?: boolean };
  getExecuting(): ActivityApi[];
}

/** 第一批仅开放直线审批；未接通的策略明确拒绝，不能静默跳过。 */
export function runtimeNodes(designer: WorkflowDesignerDto): WorkflowNode[] {
  for (const node of designer.nodes) {
    if (
      node.type !== 'approve' ||
      !['users', 'applicant'].includes(node.actor?.type ?? '') ||
      node.empty === 'administrator' ||
      node.skipRepeated ||
      node.timeout ||
      Object.values(node.fieldPermissions ?? {}).includes('editable')
    )
      throw crudErrors.badRequest(
        `“${node.name}”使用的策略尚未接通审批执行，请先使用指定成员/本人、直线审批、空人通过或停止，关闭重复跳过、超时及节点编辑权限`,
      );
  }
  return designer.nodes;
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
  let engineError: unknown;
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
          const actors = input.actors[count[1]!];
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
    const emptyPassed: string[] = [];
    for (let step = 0; step <= nodes.length; step++) {
      const empty = waits().find((w) => input.actors[w.nodeId]!.length === 0);
      if (!empty) break;
      if (nodeMap.get(empty.nodeId)?.empty !== 'pass' || step === nodes.length)
        throw new Error('不允许自动通过无办理人节点');
      execution.signal({
        id: `node_${empty.nodeId}`,
        executionId: empty.executionId,
        approved: true,
      });
      emptyPassed.push(empty.nodeId);
      await settle();
    }
    const postponed = waits();
    const ended = execution.state === 'idle';
    if (!ended && postponed.length === 0)
      throw new Error('流程未结束且没有可持久化待办');
    const state = await engine.getState();
    if (Buffer.byteLength(JSON.stringify(state)) > 2 * 1024 * 1024)
      throw crudErrors.badRequest('流程引擎快照超过2MiB限制');
    return { state, waits: postponed, ended, emptyPassed };
  } finally {
    await engine.stop();
  }
}
