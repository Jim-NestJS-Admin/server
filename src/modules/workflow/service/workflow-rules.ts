import { createHash } from 'node:crypto';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import {
  STATE_RANK,
  type FieldState,
} from '../../../core/field-perm/field-perm.decorator.js';
import type { FormFieldDto } from '../../form/dto/form.dto.js';
import type {
  WorkflowActor,
  WorkflowCondition,
  WorkflowDesignerDto,
  WorkflowNode,
} from '../dto/workflow.dto.js';

type Obj = Record<string, unknown>;
const ID = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const DB_ID = /^[1-9]\d{0,19}$/;
const STATES = ['hidden', 'masked', 'readonly', 'editable'] as const;
export function workflowInvalid(path: string, message: string): never {
  throw crudErrors.badRequest('流程配置不合法', [
    { field: path, messages: [message] },
  ]);
}
function object(value: unknown, path: string, allowed: string[]): Obj {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(value) as object | null,
    )
  )
    workflowInvalid(path, '必须是普通JSON对象');
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      workflowInvalid(
        `${path}.${key}`,
        '不支持此配置，禁止脚本、表达式、远程调用或自定义BPMN',
      );
  return value as Obj;
}
function text(value: unknown, path: string, max = 100): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[<>]|\$\{|\$FN:|=>|\bfunction\s*\(/i.test(value) ||
    hasControl(value)
  )
    workflowInvalid(path, `请填写1–${max}位纯文本，禁止HTML或脚本`);
  return value;
}
function hasControl(value: string) {
  for (let i = 0; i < value.length; i++)
    if (value.charCodeAt(i) < 32) return true;
  return false;
}
function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !ID.test(value))
    workflowInvalid(path, '标识须以字母开头，最多48位字母、数字及下划线');
  return value;
}
function ids(value: unknown, path: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 50 ||
    value.some((v) => typeof v !== 'string' || !DB_ID.test(v)) ||
    new Set(value).size !== value.length
  )
    workflowInvalid(path, '请选择1–50个有效且不重复的编号');
  return value as string[];
}
export interface WorkflowReferences {
  users: string[];
  roles: string[];
  orgs: string[];
}
export interface ParsedWorkflow {
  designer: WorkflowDesignerDto;
  nodeCount: number;
  references: WorkflowReferences;
}

/** 固定树结构保证无任意连线/环；所有条件均为结构化白名单，不保存客户端表达式。 */
export function parseWorkflow(
  input: unknown,
  fields: FormFieldDto[],
  delegable: FieldState,
): ParsedWorkflow {
  const seenObjects = new Set<object>();
  const checkJson = (v: unknown, depth: number) => {
    if (depth > 32)
      workflowInvalid('data.designer', '流程JSON嵌套不能超过32层');
    if (v && typeof v === 'object') {
      if (seenObjects.has(v))
        workflowInvalid('data.designer', '流程不能循环引用');
      seenObjects.add(v);
      for (const item of Object.values(v)) checkJson(item, depth + 1);
      seenObjects.delete(v);
    } else if (
      !['string', 'number', 'boolean'].includes(typeof v) &&
      v !== null
    )
      workflowInvalid('data.designer', '流程只能包含JSON数据');
  };
  checkJson(input, 0);
  if (Buffer.byteLength(JSON.stringify(input)) > 65536)
    workflowInvalid('data.designer', '流程配置不能超过64KiB');
  const root = object(structuredClone(input), 'data.designer', [
    'schemaVersion',
    'nodes',
  ]);
  if (root.schemaVersion !== 1)
    workflowInvalid('data.designer.schemaVersion', '不支持的流程契约版本');
  const fieldMap = new Map(fields.map((f) => [f.field, f]));
  const nodeIds = new Set<string>();
  const refs = {
    users: new Set<string>(),
    roles: new Set<string>(),
    orgs: new Set<string>(),
  };
  let nodeCount = 0,
    approvals = 0;
  function actor(value: unknown, path: string): WorkflowActor {
    const a = object(value, path, ['type', 'ids', 'level']);
    if (
      ![
        'users',
        'roles',
        'department_leader',
        'supervisor',
        'self_select',
        'applicant',
      ].includes(String(a.type))
    )
      workflowInvalid(`${path}.type`, '请选择有效的审批人或抄送人来源');
    if (a.type === 'users' || a.type === 'roles') {
      if (a.level !== undefined)
        workflowInvalid(path, '指定成员或角色不能配置上级层数');
      for (const id of ids(a.ids, `${path}.ids`)) refs[a.type].add(id);
    } else {
      if (a.ids !== undefined)
        workflowInvalid(path, '当前来源不能直接指定成员或角色');
      if (a.type === 'department_leader' || a.type === 'supervisor') {
        if (
          !Number.isInteger(a.level) ||
          Number(a.level) < 1 ||
          Number(a.level) > 10
        )
          workflowInvalid(`${path}.level`, '上级层数须为1–10');
      } else if (a.level !== undefined)
        workflowInvalid(path, '当前来源不能配置上级层数');
    }
    return a as unknown as WorkflowActor;
  }
  function condition(
    value: unknown,
    path: string,
    budget: { count: number },
    depth = 0,
  ): WorkflowCondition {
    if (++budget.count > 20 || depth > 3)
      workflowInvalid(path, '每个分支最多20个条件，分组深度最多3层');
    const c = object(value, path, [
      'logic',
      'conditions',
      'source',
      'field',
      'operator',
      'value',
    ]);
    if (c.logic !== undefined) {
      object(c, path, ['logic', 'conditions']);
      if (
        typeof c.logic !== 'string' ||
        !['all', 'any'].includes(c.logic) ||
        !Array.isArray(c.conditions) ||
        !c.conditions.length
      )
        workflowInvalid(path, '条件组须选择且/或，并包含条件');
      return {
        logic: c.logic as 'all' | 'any',
        conditions: c.conditions.map((v, i) =>
          condition(v, `${path}.conditions[${i}]`, budget, depth + 1),
        ),
      };
    }
    object(c, path, ['source', 'field', 'operator', 'value']);
    if (
      !['field', 'applicant_org', 'applicant_role'].includes(String(c.source))
    )
      workflowInvalid(path, '不支持的条件来源');
    const isSet = ['in', 'not_in'].includes(String(c.operator));
    const values = isSet ? c.value : [c.value];
    if (!Array.isArray(values) || !values.length || values.length > 100)
      workflowInvalid(`${path}.value`, '条件值须为1–100项');
    let type: 'string' | 'number' | 'boolean' = 'string';
    let ordered = false;
    if (c.source === 'field') {
      const f = typeof c.field === 'string' ? fieldMap.get(c.field) : undefined;
      if (!f || !f.visible || !f.queryable || f.multiple)
        workflowInvalid(
          `${path}.field`,
          '请选择当前表单版本中可查询、可见的标量字段',
        );
      type =
        f.type === 'number'
          ? 'number'
          : f.type === 'boolean'
            ? 'boolean'
            : 'string';
      ordered = f.type === 'number' || f.component === 'datePicker';
      for (const value of values) {
        if (f.component === 'datePicker') {
          const date =
            typeof value === 'string'
              ? new Date(`${value}T00:00:00Z`)
              : new Date(NaN);
          if (
            typeof value !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
            !Number.isFinite(date.getTime()) ||
            date.toISOString().slice(0, 10) !== value
          )
            workflowInvalid(
              `${path}.value`,
              '日期条件必须为有效的YYYY-MM-DD日期',
            );
        }
        if (f.options.length && !f.options.some((o) => o.value === value))
          workflowInvalid(`${path}.value`, '条件值不在表单选项中');
      }
    } else {
      if (c.field !== undefined)
        workflowInvalid(path, '组织/角色条件不能配置表单字段');
      for (const id of ids(values, `${path}.value`))
        refs[c.source === 'applicant_org' ? 'orgs' : 'roles'].add(id);
    }
    if (
      ![
        'eq',
        'ne',
        'in',
        'not_in',
        ...(ordered ? ['gt', 'gte', 'lt', 'lte'] : []),
      ].includes(String(c.operator))
    )
      workflowInvalid(`${path}.operator`, '运算符不适用于此字段');
    for (const value of values) {
      if (
        typeof value !== type ||
        (typeof value === 'number' && !Number.isFinite(value))
      )
        workflowInvalid(
          `${path}.value`,
          '条件值类型必须与字段一致，不自动转换',
        );
      if (typeof value === 'string') text(value, `${path}.value`, 200);
    }
    return c as unknown as WorkflowCondition;
  }
  function nodes(value: unknown, path: string, depth: number): WorkflowNode[] {
    if (!Array.isArray(value) || depth > 12)
      workflowInvalid(path, '节点须为数组，节点嵌套最多12层');
    return value.map((raw, i) => {
      const p = `${path}[${i}]`;
      const n = object(raw, p, [
        'id',
        'name',
        'type',
        'actor',
        'mode',
        'empty',
        'skipRepeated',
        'rejectTo',
        'timeout',
        'fieldPermissions',
        'branches',
      ]);
      const id = identifier(n.id, `${p}.id`);
      if (nodeIds.has(id) || ++nodeCount > 200)
        workflowInvalid(`${p}.id`, '节点标识不能重复，整个流程最多200个节点');
      nodeIds.add(id);
      text(n.name, `${p}.name`);
      if (n.type === 'approve' || n.type === 'copy') {
        if (n.branches !== undefined)
          workflowInvalid(p, '审批/抄送节点不能包含分支');
        actor(n.actor, `${p}.actor`);
        if (n.type === 'approve') {
          approvals++;
          if (!['sequential', 'all', 'any'].includes(String(n.mode)))
            workflowInvalid(`${p}.mode`, '请选择依次审批、会签或或签');
          if (!['pass', 'administrator', 'stop'].includes(String(n.empty)))
            workflowInvalid(`${p}.empty`, '请选择审批人为空时的处理方式');
          if (typeof n.skipRepeated !== 'boolean' || n.rejectTo !== 'applicant')
            workflowInvalid(p, '须明确相邻重复审批策略，驳回仅支持回到申请人');
          if (n.timeout !== undefined) {
            const timeout = object(n.timeout, `${p}.timeout`, [
              'minutes',
              'action',
            ]);
            if (
              !Number.isInteger(timeout.minutes) ||
              Number(timeout.minutes) < 1 ||
              Number(timeout.minutes) > 525600 ||
              !['remind', 'supervisor'].includes(String(timeout.action))
            )
              workflowInvalid(
                `${p}.timeout`,
                '超时须为1–525600分钟，动作仅提醒或转上级',
              );
          }
        } else if (
          ['mode', 'empty', 'skipRepeated', 'rejectTo', 'timeout'].some(
            (k) => n[k] !== undefined,
          )
        )
          workflowInvalid(p, '抄送节点不能配置审批行为');
        if (n.fieldPermissions !== undefined) {
          const permissions = object(
            n.fieldPermissions,
            `${p}.fieldPermissions`,
            [...fieldMap.keys()],
          );
          if (
            n.type === 'copy' &&
            Object.values(permissions).includes('editable')
          )
            workflowInvalid(p, '抄送字段不可编辑');
          for (const [key, state] of Object.entries(permissions)) {
            if (!STATES.includes(state as FieldState))
              workflowInvalid(
                `${p}.fieldPermissions.${key}`,
                '请选择有效字段权限',
              );
            const field = fieldMap.get(key)!;
            const cap = !field.visible
              ? 'hidden'
              : field.generated && delegable === 'editable'
                ? 'readonly'
                : delegable;
            if (STATE_RANK[state as FieldState] > STATE_RANK[cap])
              workflowInvalid(
                `${p}.fieldPermissions.${key}`,
                '节点权限超过字段可委派上限',
              );
          }
        }
      } else if (n.type === 'condition' || n.type === 'parallel') {
        if (
          [
            'actor',
            'mode',
            'empty',
            'skipRepeated',
            'rejectTo',
            'timeout',
            'fieldPermissions',
          ].some((k) => n[k] !== undefined)
        )
          workflowInvalid(p, '分支节点不能配置审批人或字段权限');
        if (
          !Array.isArray(n.branches) ||
          n.branches.length < 2 ||
          n.branches.length > 10
        )
          workflowInvalid(`${p}.branches`, '分支数量须为2–10');
        const branchIds = new Set<string>();
        let defaults = 0;
        n.branches = n.branches.map((rawBranch, j, branches) => {
          const bp = `${p}.branches[${j}]`;
          const b = object(rawBranch, bp, [
            'id',
            'name',
            'nodes',
            'condition',
            'default',
          ]);
          const bid = identifier(b.id, `${bp}.id`);
          if (branchIds.has(bid))
            workflowInvalid(`${bp}.id`, '分支标识不能重复');
          branchIds.add(bid);
          text(b.name, `${bp}.name`);
          if (n.type === 'condition') {
            if (b.default === true) {
              defaults++;
              if (j !== branches.length - 1 || b.condition !== undefined)
                workflowInvalid(bp, '默认分支必须在最后，且不能有条件');
            } else {
              if (b.default !== undefined && b.default !== false)
                workflowInvalid(bp, '默认分支标记须为布尔值');
              b.condition = condition(b.condition, `${bp}.condition`, {
                count: 0,
              });
            }
          } else if (b.condition !== undefined || b.default !== undefined)
            workflowInvalid(bp, '并行分支不能设置条件或默认分支');
          b.nodes = nodes(b.nodes, `${bp}.nodes`, depth + 1);
          if (n.type === 'parallel' && !(b.nodes as WorkflowNode[]).length)
            workflowInvalid(bp, '并行分支至少包含一个节点');
          return b;
        });
        if (n.type === 'condition' && defaults !== 1)
          workflowInvalid(p, '条件分支必须恰有一个默认分支');
      } else
        workflowInvalid(`${p}.type`, '只支持审批、抄送、条件分支和并行分支');
      return n as unknown as WorkflowNode;
    });
  }
  const designer: WorkflowDesignerDto = {
    schemaVersion: 1,
    nodes: nodes(root.nodes, 'data.designer.nodes', 0),
  };
  if (!approvals)
    workflowInvalid('data.designer.nodes', '流程至少包含一个审批节点');
  return {
    designer: structuredClone(designer),
    nodeCount,
    references: {
      users: [...refs.users],
      roles: [...refs.roles],
      orgs: [...refs.orgs],
    },
  };
}

/** 只把已校验的树编译为固定BPMN标签；服务名/表达式模板不接受用户输入。 */
export function compileWorkflow(
  designer: WorkflowDesignerDto,
  processId: string,
) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(processId))
    throw new Error('内部流程标识无效');
  const xml = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&apos;',
        })[c]!,
    );
  const elements = ['<startEvent id="wf_start"/>', '<endEvent id="wf_end"/>'];
  let counter = 0;
  function flow(
    from: string,
    to: string,
    expression?: string,
    identity?: string,
  ) {
    const id = identity ?? `flow_${++counter}`;
    elements.push(
      `<sequenceFlow id="${id}" sourceRef="${from}" targetRef="${to}">${expression ? `<conditionExpression xsi:type="tFormalExpression">${xml(expression)}</conditionExpression>` : ''}</sequenceFlow>`,
    );
  }
  function sequence(nodes: WorkflowNode[], from: string, to: string) {
    let last = from;
    for (const n of nodes) {
      const id = `node_${n.id}`;
      flow(last, id);
      if (n.type === 'approve') {
        const count = `\${environment.services.workflowApproverCount("${n.id}")}`;
        const completion = `\${environment.services.workflowAnyApproved("${n.id}", content)}`;
        elements.push(
          `<userTask id="${id}" name="${xml(n.name)}"><multiInstanceLoopCharacteristics isSequential="${n.mode === 'sequential'}"><loopCardinality xsi:type="tFormalExpression">${xml(count)}</loopCardinality>${n.mode === 'any' ? `<completionCondition xsi:type="tFormalExpression">${xml(completion)}</completionCondition>` : ''}</multiInstanceLoopCharacteristics></userTask>`,
        );
        last = id;
      } else if (n.type === 'copy') {
        elements.push(
          `<serviceTask id="${id}" name="${xml(n.name)}" implementation="\${environment.services.workflowCopy}"/>`,
        );
        last = id;
      } else {
        const join = `merge_${n.id}`;
        const gateway =
          n.type === 'condition' ? 'exclusiveGateway' : 'parallelGateway';
        const defaultId = `default_${n.id}`;
        elements.push(
          `<${gateway} id="${id}" name="${xml(n.name)}"${n.type === 'condition' ? ` default="${defaultId}"` : ''}/>`,
          `<${gateway} id="${join}"/>`,
        );
        for (const [i, branch] of n.branches!.entries()) {
          const entry = `branch_${n.id}_${i}`;
          elements.push(`<exclusiveGateway id="${entry}"/>`);
          const expression =
            n.type === 'condition' && !branch.default
              ? `\${environment.services.workflowBranch("${n.id}","${branch.id}")}`
              : undefined;
          flow(id, entry, expression, branch.default ? defaultId : undefined);
          sequence(branch.nodes, entry, join);
        }
        last = join;
      }
    }
    flow(last, to);
  }
  sequence(designer.nodes, 'wf_start', 'wf_end');
  const bpmn = `<?xml version="1.0" encoding="UTF-8"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" targetNamespace="urn:jim:workflow:v1"><process id="${processId}" isExecutable="true">${elements.join('')}</process></definitions>`;
  return {
    bpmn,
    digest: createHash('sha256')
      .update(JSON.stringify(designer))
      .update('\n')
      .update(bpmn)
      .digest('hex'),
  };
}
