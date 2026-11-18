import { advanceWorkflow } from './workflow-engine.js';
import { compileWorkflow } from './workflow-rules.js';
import type { WorkflowDesignerDto } from '../dto/workflow.dto.js';

it('真实引擎可持久化单人待办、恢复办理并返回结束结果', async () => {
  const designer = {
    schemaVersion: 1,
    nodes: [
      {
        id: 'one',
        name: '审批',
        type: 'approve',
        actor: { type: 'applicant' },
        mode: 'all',
        empty: 'stop',
        skipRepeated: false,
        rejectTo: 'applicant',
      },
    ],
  } as WorkflowDesignerDto;
  const compiled = compileWorkflow(designer, 'wf_test_v1');
  const input = {
    code: 'test',
    revision: 1,
    designer,
    ...compiled,
    compilerVersion: 2,
    actors: { one: ['1'] },
    values: {},
    applicantOrgId: null,
    applicantRoles: [],
    approvedBy: {},
    decisions: {},
  };
  const first = await advanceWorkflow(input);
  expect(first.ended).toBe(false);
  expect(first.waits).toHaveLength(1);
  const second = await advanceWorkflow({
    ...input,
    state: first.state,
    signal: first.waits[0],
  });
  expect(second.ended).toBe(true);
  expect(second.waits).toHaveLength(0);
}, 10000);
