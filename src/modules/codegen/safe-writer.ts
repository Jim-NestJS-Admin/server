import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, sep } from 'node:path';

/** 每个项目允许写入的子目录（架构「生成器的安全边界 · 只能写进白名单子目录」） */
const ALLOWED: Record<'server' | 'admin', string[]> = {
  server: ['src/modules/', 'src/database/migrations/'],
  admin: ['src/views/', 'src/locales/'],
};
/** 不管在哪个目录都不能写的名字 */
const FORBIDDEN =
  /(^|\/)(\.git|\.env[^/]*|node_modules|AGENTS\.md|CLAUDE\.md|package\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json)(\/|$)/i;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class UnsafePathError extends Error {}

export const fingerprint = (content: string) =>
  createHash('sha256').update(content, 'utf8').digest('hex');

/**
 * 把「项目 + 相对路径」解析成真实的绝对路径，越界一律抛错：
 * 拒绝绝对路径、..、盘符和 Windows 备用数据流（冒号）、反斜杠、网络路径、白名单外目录、禁止的文件名；
 * 再把已经存在的最深一级目录解析成真实路径，确认还在根目录里（挡住符号链接、目录联接跳出）。
 */
export function resolveSafe(
  root: string,
  project: 'server' | 'admin',
  rel: string,
): string {
  if (!root || !isAbsolute(root))
    throw new UnsafePathError('输出根目录没有配置');
  if (
    isAbsolute(rel) ||
    rel.includes('\\') ||
    rel.includes(':') ||
    rel.startsWith('/')
  )
    throw new UnsafePathError(`路径不合法：${rel}`);
  const parts = rel.split('/');
  if (parts.some((p) => p === '..' || p === '.' || !SEGMENT.test(p)))
    throw new UnsafePathError(`路径不合法：${rel}`);
  if (!ALLOWED[project].some((p) => rel.startsWith(p)))
    throw new UnsafePathError(`不在允许写入的目录里：${rel}`);
  if (FORBIDDEN.test(rel))
    throw new UnsafePathError(`这个文件不允许生成：${rel}`);
  const realRoot = realpathSync(root);
  const target = join(realRoot, ...parts);
  let probe = dirname(target);
  while (!existsSync(probe)) probe = dirname(probe);
  const realProbe = realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep))
    throw new UnsafePathError(`路径通过链接跳出了项目目录：${rel}`);
  if (existsSync(target)) {
    const realTarget = realpathSync(target);
    if (!realTarget.startsWith(realRoot + sep))
      throw new UnsafePathError(`文件是指向项目外的链接：${rel}`);
  }
  return target;
}

export async function currentFingerprint(abs: string): Promise<string | null> {
  try {
    return fingerprint(await readFile(abs, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeSafe(abs: string, content: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}
