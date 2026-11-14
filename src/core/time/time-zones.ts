import { TIME_ZONE_CITIES } from './time-zone-cities.js';

const common = [
  'Asia/Shanghai',
  'UTC',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
];
const regions: Record<string, string> = {
  Africa: '非洲',
  America: '美洲',
  Antarctica: '南极洲',
  Arctic: '北极',
  Asia: '亚洲',
  Atlantic: '大西洋',
  Australia: '澳大利亚',
  Europe: '欧洲',
  Indian: '印度洋',
  Pacific: '太平洋',
};
const supported = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);
const catalog = [...supported]
  .map((value) => {
    if (value === 'UTC')
      return {
        value,
        labelZh: '协调世界时（UTC）',
        labelEn: 'Coordinated Universal Time (UTC)',
        common: true,
      };
    const parts = value.split('/'),
      city = parts.slice(1).join(' / ').replaceAll('_', ' ');
    return {
      value,
      labelZh: `${regions[parts[0]] ?? parts[0]} / ${TIME_ZONE_CITIES[value] ?? city}（${value}）`,
      labelEn: `${city} (${value})`,
      common: common.includes(value),
    };
  })
  .sort((a, b) => {
    const ai = common.indexOf(a.value),
      bi = common.indexOf(b.value);
    return ai >= 0 || bi >= 0
      ? (ai < 0 ? common.length : ai) - (bi < 0 ? common.length : bi)
      : a.value.localeCompare(b.value);
  });

/** 目录跟随服务端ICU/IANA能力，中文名称固定来自CLDR；不由租户字典改写。 */
export function timeZoneCatalog() {
  return catalog.map((item) => ({ ...item }));
}

/** 新值规范为运行时支持的IANA标识；历史值保持原样，由实际计算独立校验。 */
export function canonicalTimeZone(value: string) {
  if (typeof value !== 'string' || !value) throw new RangeError('时区不能为空');
  const canonical = new Intl.DateTimeFormat('en', {
    timeZone: value,
  }).resolvedOptions().timeZone;
  if (!supported.has(canonical)) throw new RangeError('不是受支持的IANA时区');
  return canonical;
}
