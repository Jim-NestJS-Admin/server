import { compileWorkflow } from './workflow-rules.js';
import type { WorkflowDesignerDto } from '../dto/workflow.dto.js';

it('流程v2摘要不受数据库JSON对象键顺序影响，数组语义不变', () => {
  const a = {
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
  const reordered = JSON.parse(JSON.stringify(a), (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value,
  ) as WorkflowDesignerDto;
  expect(compileWorkflow(a, 'wf_test_v1')).toEqual(
    compileWorkflow(reordered, 'wf_test_v1'),
  );
  expect(compileWorkflow(a, 'wf_test_v1', 1).digest).not.toBe(
    compileWorkflow(reordered, 'wf_test_v1', 1).digest,
  );
  const changed = structuredClone(a);
  changed.nodes[0]!.name = '另一审批';
  expect(compileWorkflow(a, 'wf_test_v1').digest).not.toBe(
    compileWorkflow(changed, 'wf_test_v1').digest,
  );
});
