import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { parseFormDesigner, validateFormValues } from './form-rules.js';

const design = <T extends object = object>(
  rule: object[],
  extra: T = {} as T,
) => ({
  schemaVersion: 1,
  rule,
  ...extra,
});
const input = (extra: object = {}) => ({
  type: 'input',
  field: 'name',
  title: '名称',
  ...extra,
});
function errorField(fn: () => unknown, expected: string) {
  try {
    fn();
    throw new Error('预期拒绝但调用成功');
  } catch (error) {
    expect(error).toBeInstanceOf(BusinessException);
    expect((error as BusinessException).getStatus()).toBe(400);
    expect((error as BusinessException).details).toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ field: expected }),
      ]),
    });
  }
}

describe('T35 表单规则安全边界', () => {
  it('解析嵌套布局、选项类型、必填、范围和供权限/查询/多语言消费的清单', () => {
    const parsed = parseFormDesigner(
      design([
        {
          type: 'el-row',
          children: [
            input({
              $required: true,
              meta: { multilingual: true, queryable: false },
              props: { type: 'textarea', maxlength: 200 },
            }),
          ],
        },
        {
          type: 'inputNumber',
          field: 'amount',
          title: '金额',
          props: { min: 0, precision: 2 },
          validate: [{ max: 50000 }],
        },
        {
          type: 'select',
          field: 'kind',
          title: '类别',
          options: [{ label: '第一类', value: 1 }],
        },
      ]),
    );
    expect(parsed.fields).toMatchObject([
      {
        field: 'name',
        required: true,
        type: 'string',
        multilingual: true,
        queryable: false,
        validation: { max: 200 },
      },
      {
        field: 'amount',
        type: 'number',
        validation: { min: 0, max: 50000, precision: 2 },
      },
      { field: 'kind', type: 'number', options: [{ value: 1 }] },
    ]);
    expect(() =>
      validateFormValues(parsed, { name: '请假', amount: 50000, kind: 1 }),
    ).not.toThrow();
  });

  it.each([
    ['事件', { on: { change: 'alert(1)' } }],
    ['生命周期', { hook: { mounted: 'alert(1)' } }],
    ['表达式', { computed: { value: '1+1' } }],
    ['原生联动', { control: [] }],
    ['自定义校验', { validate: [{ validator: 'return true' }] }],
    ['任意正则', { validate: [{ pattern: '(a+)+$' }] }],
    ['默认值序列化函数', { value: '[[FORM-CREATE-PREFIX-function()=>1]]' }],
    ['属性内脚本', { props: { onChange: 'alert(1)' } }],
    ['远程加载', { fetch: { action: 'https://example.com' } }],
    ['HTML标题', { title: '<img src=x onerror=alert(1)>' }],
  ])('拒绝%s', (_label, extra) => {
    expect(() => parseFormDesigner(design([input(extra)]))).toThrow(
      BusinessException,
    );
  });

  it.each(['template', 'html', 'iframe', 'upload', 'CustomComponent'])(
    '拒绝非白名单组件 %s',
    (type) => {
      errorField(
        () => parseFormDesigner(design([input({ type })])),
        'data.designer.rule.0.type',
      );
    },
  );

  it('拒绝原型键、函数、重复字段、深层布局与超大定义', () => {
    expect(() =>
      parseFormDesigner(
        JSON.parse('{"schemaVersion":1,"rule":[],"__proto__":{}}'),
      ),
    ).toThrow();
    expect(() =>
      parseFormDesigner(design([input({ props: { placeholder: () => 1 } })])),
    ).toThrow();
    expect(() => parseFormDesigner(design([input(), input()]))).toThrow();
    let rule: object[] = [input()];
    for (let i = 0; i < 14; i++) rule = [{ type: 'row', children: rule }];
    expect(() => parseFormDesigner(design(rule))).toThrow();
    expect(() =>
      parseFormDesigner(
        design(
          Array.from({ length: 201 }, (_, i) => input({ field: `f${i}` })),
        ),
      ),
    ).toThrow();
    expect(() =>
      parseFormDesigner(
        design(
          Array.from({ length: 5 }, (_, i) =>
            input({ field: `f${i}`, info: 'x'.repeat(20000) }),
          ),
        ),
      ),
    ).toThrow();
  });

  it('拒绝不受支持的选项/规则，不静默降级', () => {
    expect(() =>
      parseFormDesigner(
        design([
          input({
            type: 'select',
            options: [
              { label: 'a', value: 1 },
              { label: 'b', value: 1 },
            ],
          }),
        ]),
      ),
    ).toThrow();
    expect(() =>
      parseFormDesigner(
        design([
          input({
            type: 'select',
            options: [
              { label: 'a', value: '1' },
              { label: 'b', value: 2 },
            ],
          }),
        ]),
      ),
    ).toThrow();
    expect(() =>
      parseFormDesigner(
        design([input({ validate: [{ min: 5 }, { max: 2 }] })]),
      ),
    ).toThrow();
    expect(() =>
      parseFormDesigner(
        design([input({ $required: true, validate: [{ required: 'yes' }] })]),
      ),
    ).toThrow();
    expect(() => parseFormDesigner(design([input({ value: 123 })]))).toThrow();
  });
});

describe('T35 版本字段清单提交校验', () => {
  const parsed = () =>
    parseFormDesigner(
      design([
        input({ $required: true, validate: [{ min: 2, max: 10 }] }),
        {
          type: 'inputNumber',
          field: 'amount',
          title: '金额',
          props: { min: 0, max: 100, precision: 2 },
        },
        { type: 'switch', field: 'enabled', title: '启用', $required: true },
        {
          type: 'checkbox',
          field: 'tags',
          title: '标签',
          options: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
        },
        {
          type: 'datePicker',
          field: 'day',
          title: '日期',
          props: { valueFormat: 'YYYY-MM-DD' },
        },
        input({ field: 'email', title: '邮箱', validate: [{ type: 'email' }] }),
      ]),
    );
  it('0和false是合法值，不做隐式类型转换', () => {
    expect(() =>
      validateFormValues(parsed(), {
        name: '测试',
        amount: 0,
        enabled: false,
        tags: ['a'],
        day: '2024-02-29',
        email: 'qa@example.test',
      }),
    ).not.toThrow();
    errorField(
      () =>
        validateFormValues(parsed(), {
          name: '测试',
          amount: '1',
          enabled: false,
        }),
      'data.amount',
    );
    errorField(
      () => validateFormValues(parsed(), { name: '测试', enabled: 'false' }),
      'data.enabled',
    );
  });
  it.each([
    ['name', { name: ' ' }],
    ['name', { name: 'x' }],
    ['amount', { amount: -1 }],
    ['amount', { amount: 1.234 }],
    ['tags', { tags: ['a', 'a'] }],
    ['tags', { tags: ['x'] }],
    ['day', { day: '2026-02-30' }],
    ['email', { email: 'not-email' }],
    ['tenantId', { tenantId: '2' }],
  ])('拒绝不合法字段 %s', (field, data) => {
    errorField(
      () =>
        validateFormValues(parsed(), { name: '测试', enabled: false, ...data }),
      `data.${field}`,
    );
  });

  const linked = () =>
    design(
      [
        {
          type: 'select',
          field: 'kind',
          title: '类型',
          options: [
            { label: '个人', value: 'person' },
            { label: '公司', value: 'company' },
          ],
        },
        input({ field: 'company', title: '公司名称' }),
        {
          type: 'select',
          field: 'city',
          title: '城市',
          options: [
            { label: '甲', value: 'a' },
            { label: '乙', value: 'b' },
          ],
        },
      ],
      {
        linkages: [
          {
            source: 'kind',
            operator: 'eq',
            value: 'company',
            target: 'company',
            action: 'visible',
            whenTrue: true,
            whenFalse: false,
          },
          {
            source: 'kind',
            operator: 'eq',
            value: 'company',
            target: 'company',
            action: 'required',
            whenTrue: true,
            whenFalse: false,
          },
          {
            source: 'kind',
            operator: 'eq',
            value: 'company',
            target: 'city',
            action: 'options',
            whenTrue: [{ label: '甲', value: 'a' }],
            whenFalse: [{ label: '乙', value: 'b' }],
          },
        ],
      },
    );
  it('显示、必填、选项联动在后端重新计算，隐藏字段不能偷偷提交', () => {
    const config = parseFormDesigner(linked());
    expect(() =>
      validateFormValues(config, { kind: 'person', city: 'b' }),
    ).not.toThrow();
    errorField(
      () => validateFormValues(config, { kind: 'person', company: '偷填' }),
      'data.company',
    );
    errorField(
      () => validateFormValues(config, { kind: 'company', city: 'a' }),
      'data.company',
    );
    errorField(
      () => validateFormValues(config, { kind: 'person', city: 'a' }),
      'data.city',
    );
  });
  it('禁止循环和越过原选项的联动', () => {
    const v = linked();
    v.linkages[0].source = 'company';
    v.linkages[0].target = 'kind';
    expect(() => parseFormDesigner(v)).toThrow();
    const v2 = linked();
    v2.linkages[2].whenTrue = [{ label: '外部值', value: 'x' }];
    expect(() => parseFormDesigner(v2)).toThrow();
  });
});
