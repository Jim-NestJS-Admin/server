import { canonicalTimeZone, timeZoneCatalog } from './time-zones.js';
import { dateParts } from '../../modules/code-rule/service/rule-config.js';
describe('系统时区目录', () => {
  it('包含运行时支持的全部标准时区和UTC，带中文名，常用项靠前且无重复', () => {
    const list = timeZoneCatalog();
    expect(list.length).toBe(Intl.supportedValuesOf('timeZone').length + 1);
    expect(new Set(list.map((x) => x.value)).size).toBe(list.length);
    expect(list[0]!.value).toBe('Asia/Shanghai');
    expect(list.find((x) => x.value === 'America/New_York')?.labelZh).toContain(
      '纽约',
    );
    expect(list.find((x) => x.value === 'UTC')).toBeTruthy();
    for (const item of list)
      expect(() =>
        new Intl.DateTimeFormat('en', { timeZone: item.value }).format(),
      ).not.toThrow();
    list[0]!.labelZh = '修改副本';
    expect(timeZoneCatalog()[0]!.labelZh).toContain('上海');
  });
  it('新值规范化别名，拒绝任意字符串和固定偏移', () => {
    expect(canonicalTimeZone('Etc/UTC')).toBe('UTC');
    expect(canonicalTimeZone('US/Eastern')).toBe('America/New_York');
    expect(() => canonicalTimeZone('invalid/zone')).toThrow();
    expect(() => canonicalTimeZone('+08:00')).toThrow();
  });
  it('纽约夏令时切换由时区引擎处理，不使用固定UTC偏移', () => {
    const before = dateParts(
        'America/New_York',
        new Date('2026-03-08T06:59:59Z'),
      ),
      after = dateParts('America/New_York', new Date('2026-03-08T07:00:00Z'));
    expect([before.HH, before.mm, before.ss]).toEqual(['01', '59', '59']);
    expect([after.HH, after.mm, after.ss]).toEqual(['03', '00', '00']);
  });
});
