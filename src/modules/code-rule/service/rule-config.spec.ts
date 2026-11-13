import {
  validateConfig,
  compatible,
  periodKey,
  renderCode,
  maximum,
} from './rule-config.js';
const config = () => ({
  timezone: 'Asia/Shanghai',
  resetPeriod: 'day',
  start: '1',
  segments: [
    { type: 'literal' as const, value: 'SO-' },
    { type: 'date' as const, format: 'yyyyMMdd' },
    { type: 'sequence' as const, width: 4 },
  ],
});
describe('编码规则安全子集', () => {
  it('固定长度、周期和时区使用同一日期，起始值及最大值均能渲染', () => {
    const c = config(),
      now = new Date('2026-12-31T16:00:00Z');
    expect(validateConfig(c)).toEqual(c);
    expect(periodKey(c, now)).toBe('2027-01-01');
    expect(renderCode(c, 1n, now)).toBe('SO-202701010001');
    expect(maximum(c)).toBe(9999n);
    expect(periodKey({ ...c, resetPeriod: 'year' }, now)).toBe('2027');
    expect(periodKey({ ...c, resetPeriod: 'month' }, now)).toBe('2027-01');
    expect(periodKey({ ...c, resetPeriod: 'never' }, now)).toBe('all');
    expect(periodKey({ ...c, timezone: 'UTC' }, now)).toBe('2026-12-31');
  });
  it.each([
    { segments: [] },
    { start: '0' },
    { start: '10000' },
    { timezone: 'bad/timezone' },
    {
      segments: [
        { type: 'sequence', width: 2 },
        { type: 'literal', value: 'A' },
      ],
    },
    {
      segments: [
        { type: 'date', format: 'yyyyMM' },
        { type: 'sequence', width: 4 },
      ],
    },
    {
      segments: [
        { type: 'literal', value: '<script>' },
        { type: 'sequence', width: 4 },
      ],
    },
    { segments: [{ type: 'sequence', width: 13 }] },
    {
      segments: [
        { type: 'literal', value: 'A', on: 'evil()' },
        { type: 'sequence', width: 4 },
      ],
    },
  ])('非法配置被拒绝：%j', (patch) => {
    expect(() =>
      validateConfig({ ...config(), ...patch } as ReturnType<typeof config>),
    ).toThrow();
  });
  it('绑定校验字符集、最大最小长度和首字母，而非发号时才发现', () => {
    const u = {
      key: 'orders',
      name: '订单',
      resource: 'sales/order',
      field: 'no',
      uniqueScope: 'tenant' as const,
      allowRuleSwitch: true,
      maxLength: 32,
      charset: 'upper_alnum' as const,
    };
    expect(() => compatible(config(), u)).not.toThrow();
    expect(() => compatible(config(), { ...u, maxLength: 4 })).toThrow();
    expect(() => compatible(config(), { ...u, minLength: 30 })).toThrow();
    expect(() =>
      compatible(config(), { ...u, charset: 'lower_slug' }),
    ).toThrow();
    expect(() => compatible(config(), { ...u, charset: 'digits' })).toThrow();
  });
});
