import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSafe, UnsafePathError } from './safe-writer.js';

describe('代码生成安全写盘（T21）', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegen-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'codegen-outside-'));
  mkdirSync(join(root, 'src/modules'), { recursive: true });
  // 目录联接 / 符号链接指向项目外。Windows 普通用户建不了目录符号链接（EPERM），
  // 用目录联接（junction，不需要管理员权限）——这正是 Windows 上真实会遇到的逃逸方式
  symlinkSync(
    outside,
    join(root, 'src/modules/evil'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  it('白名单目录里的正常路径', () => {
    expect(
      resolveSafe(root, 'server', 'src/modules/crm/entity/a.entity.ts'),
    ).toContain('crm');
  });

  it.each([
    ['绝对路径', '/etc/passwd'],
    ['上级目录', 'src/modules/../../x.ts'],
    ['反斜杠', 'src\\modules\\x.ts'],
    ['盘符 / 备用数据流', 'src/modules/a.ts:stream'],
    ['白名单外目录', 'src/core/x.ts'],
    ['禁止的文件', 'src/modules/.env'],
    ['依赖目录', 'src/modules/node_modules/x.js'],
    ['通过链接跳出项目', 'src/modules/evil/x.ts'],
  ])('%s：拒绝', (_name, rel) => {
    expect(() => resolveSafe(root, 'server', rel)).toThrow(UnsafePathError);
  });

  it('前端只能写页面和语言包目录', () => {
    expect(() => resolveSafe(root, 'admin', 'src/modules/x.ts')).toThrow(
      UnsafePathError,
    );
  });
});
