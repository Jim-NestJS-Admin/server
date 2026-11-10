import { exportValue } from './export-value.js';
import type { CrudSchemaColumn } from './crud-schema.js';
const col = (
  field: string,
  type: CrudSchemaColumn['type'] = 'text',
): CrudSchemaColumn => ({ field, label: field, type, sortable: false });
describe('导出显示值', () => {
  it('字典、关联名称、布尔及数字使用列表语义', () => {
    expect(exportValue({ enabled: true }, col('enabled', 'boolean'))).toBe(
      '是',
    );
    expect(
      exportValue({ status: '1' }, col('status'), [
        { value: '1', label: '正常' },
      ]),
    ).toBe('正常');
    expect(
      exportValue(
        { orgId: '1', _display: { orgId: '总部' } },
        col('orgId', 'reference'),
      ),
    ).toBe('总部');
    expect(exportValue({ n: 12.5 }, col('n', 'number'))).toBe(12.5);
  });
  it('脱敏和隐藏值不会被字典或显示名恢复', () => {
    const row = {
      phone: '138****5678',
      secret: '内部值',
      _fieldState: { phone: 'masked', secret: 'hidden' },
      _display: { phone: '原文', secret: '秘密' },
    };
    expect(
      exportValue(row, col('phone'), [{ value: '138****5678', label: '原文' }]),
    ).toBe('138****5678');
    expect(exportValue(row, col('secret'))).toBe('');
    expect(exportValue({ _display: { secret: '秘密' } }, col('secret'))).toBe(
      '',
    );
  });
  it('按指定本地时区转换时间，纯日期不发生时差偏移', () => {
    expect(
      exportValue(
        { t: '2026-11-09T11:33:41.566Z' },
        col('t', 'datetime'),
        undefined,
        'Asia/Shanghai',
      ),
    ).toBe('2026-11-09 19:33:41');
    expect(
      exportValue(
        { t: '2026-11-09' },
        col('t', 'date'),
        undefined,
        'America/Los_Angeles',
      ),
    ).toBe('2026-11-09');
  });
});
