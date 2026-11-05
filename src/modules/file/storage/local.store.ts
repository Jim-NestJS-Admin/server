import { constants } from 'node:fs';
import { mkdir, realpath, open, unlink, lstat } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { assertBlobKey, BlobStore, boundedBuffer } from './blob-store.js';

/** 根目录必须是管理员配置的私有目录，不能挂在 Express/Nginx 静态目录里。 */
export class LocalBlobStore extends BlobStore {
  private readonly root: string;
  constructor(root: string) {
    super();
    if (!isAbsolute(root)) throw new Error('文件根目录必须是绝对路径');
    this.root = resolve(root);
  }
  private async path(key: string, create = false): Promise<string> {
    assertBlobKey(key);
    await this.directory(this.root, create);
    const target = resolve(this.root, ...key.split('/'));
    await this.directory(resolve(this.root, 'tenants'), create);
    await this.directory(dirname(target), create);
    return target;
  }
  private async directory(target: string, create: boolean): Promise<void> {
    try {
      if ((await realpath(target)) !== target)
        throw new Error('文件目录不能经过符号链接');
      if (!(await lstat(target)).isDirectory()) throw new Error('目标不是目录');
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
      // 先验证已有父目录，再逐级创建；不能先穿过 junction/symlink 创建目录再检查。
      await this.directory(dirname(target), true);
      try {
        await mkdir(target, { mode: 0o700 });
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason;
      }
      await this.directory(target, false);
    }
  }
  async put(key: string, data: Buffer): Promise<void> {
    const target = await this.path(key, true);
    const handle = await open(target, 'wx', 0o600);
    try {
      await handle.writeFile(data);
    } catch (error) {
      await handle.close();
      await unlink(target).catch(() => undefined);
      throw error;
    }
    await handle.close();
  }
  async get(key: string, maxBytes: number): Promise<Buffer> {
    const target = await this.path(key);
    if ((await lstat(target)).isSymbolicLink())
      throw new Error('文件不能经过符号链接');
    const handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      if (!(await handle.stat()).isFile()) throw new Error('目标不是普通文件');
      return await boundedBuffer(
        handle.createReadStream({ autoClose: false }),
        maxBytes,
      );
    } finally {
      await handle.close();
    }
  }
  async discard(key: string): Promise<void> {
    try {
      const target = await this.path(key);
      if ((await lstat(target)).isSymbolicLink())
        throw new Error('文件不能经过符号链接');
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
