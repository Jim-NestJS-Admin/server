// 只在维护时运行；生产启动不访问网络。固定版本避免数据静默变化。
import { mkdir, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const source = 'https://raw.githubusercontent.com/unicode-org/cldr-json/48.0.0/';
async function download(url) {
  let last;
  for(let i=0;i<3;i++) { try { const result=await fetch(url,{signal:AbortSignal.timeout(10000)}); if(!result.ok)throw Error(`HTTP ${result.status}`); return await result.text(); } catch(error) { last=error; } }
  throw last;
}
const text = await download(source + 'cldr-json/cldr-dates-full/main/zh/timeZoneNames.json');
const data = JSON.parse(text);
const cities = {};
function walk(value, path = []) {
  if (typeof value.exemplarCity === 'string') cities[path.join('/')] = value.exemplarCity;
  for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') walk(child, [...path, key]);
}
walk(data.main.zh.dates.timeZoneNames.zone);
const license = await download(source + 'LICENSE');
await mkdir(new URL('src/core/time/', root), { recursive: true });
await mkdir(new URL('third-party/', root), { recursive: true });
await writeFile(new URL('third-party/UNICODE-LICENSE.txt', root), license);
await writeFile(new URL('src/core/time/time-zone-cities.ts', root), '// 来自Unicode CLDR 48.0.0 exemplarCity；许可证见third-party/UNICODE-LICENSE.txt。\n// 使用scripts/update-timezone-cities.mjs更新，不手工修改生成内容。\nexport const TIME_ZONE_CITIES: Readonly<Record<string, string>> = ' + JSON.stringify(Object.fromEntries(Object.entries(cities).sort(([a],[b])=>a.localeCompare(b))), null, 2) + ';\nexport const TIME_ZONE_DATA_LICENSE = ' + JSON.stringify(license) + ';\n');
console.log(`已生成${Object.keys(cities).length}个中文城市名及Unicode许可证`);
