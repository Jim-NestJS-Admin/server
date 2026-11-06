import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FileAccess, assertPrincipal, type FileAction } from './file.ports.js';
const FILE_ACTION = Symbol('file:action');
export const FileOperation = (action: FileAction) =>
  SetMetadata(FILE_ACTION, action);
@Injectable()
export class FileGuard implements CanActivate {
  constructor(
    @Inject(FileAccess) private readonly access: FileAccess,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<FileAction>(FILE_ACTION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!action) return false;
    // Guard 在上传解析器之前执行，匿名请求不能先占用文件缓存。
    assertPrincipal(await this.access.current(action));
    return true;
  }
}
