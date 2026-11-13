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
  it('日期时间按规则时区渲染，Unix时间戳按同一时刻计算，与时区无关', () => {
    const now = new Date('2026-11-13T00:01:02.345Z');
    const c = {
      ...config(),
      resetPeriod: 'never',
      segments: [
        { type: 'literal' as const, value: 't_' },
        { type: 'date' as const, format: 'yyyyMMddHHmmss' },
        { type: 'sequence' as const, width: 4 },
      ],
    };
    expect(renderCode(validateConfig(c), 1n, now)).toBe('t_202611130801020001');
    for (const unit of ['seconds', 'milliseconds'] as const) {
      const ts = {
        ...c,
        segments: [
          { type: 'timestamp' as const, unit },
          { type: 'sequence' as const, width: 4 },
        ],
      };
      expect(validateConfig(ts)).toEqual(ts);
      expect(renderCode(ts, 1n, now)).toBe(
        String(
          unit === 'seconds' ? Math.floor(now.getTime() / 1000) : now.getTime(),
        ) + '0001',
      );
      expect(renderCode({ ...ts, timezone: 'UTC' }, 1n, now)).toBe(
        renderCode(ts, 1n, now),
      );
    }
  });
  it('时间戳单位、重复时间戳及缺日期的周期重置均拒绝', () => {
    expect(() =>
      validateConfig({
        ...config(),
        segments: [
          { type: 'timestamp', unit: 'bad' },
          { type: 'sequence', width: 4 },
        ],
      } as never),
    ).toThrow();
    expect(() =>
      validateConfig({
        ...config(),
        resetPeriod: 'never',
        segments: [
          { type: 'timestamp', unit: 'seconds' },
          { type: 'timestamp', unit: 'milliseconds' },
          { type: 'sequence', width: 4 },
        ],
      }),
    ).toThrow();
    expect(() =>
      validateConfig({
        ...config(),
        segments: [
          { type: 'timestamp', unit: 'milliseconds' },
          { type: 'sequence', width: 4 },
        ],
      }),
    ).toThrow();
  });
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
