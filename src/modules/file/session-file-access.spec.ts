import { describe, it, expect } from 'vitest';
import { SessionFileAccess } from './session-file-access.js';
import type { RequestContext } from '../../core/tenant/request-context.js';
import type { AuthzContext } from '../../core/permission/authz-context.js';

describe('文件模块只接收本次动作的正式授权', () => {
  const adapter = (
    permission?: string,
    endpoint = 'admin',
    userId: string | null = '1',
  ) =>
    new SessionFileAccess(
      {
        peek: () => ({ tenantId: '1', userId, endpoint }),
      } as unknown as RequestContext,
      { get: () => (permission ? { permission } : undefined) } as AuthzContext,
    );
  it('未登录、后台任务及没有动作授权都拒绝', async () => {
    await expect(
      adapter(undefined, 'admin', null).current('read'),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      adapter('file:asset:read', 'system').current('read'),
    ).rejects.toMatchObject({ status: 401 });
    await expect(adapter().current('read')).rejects.toMatchObject({
      status: 403,
    });
  });
  it('上传授权不能下载，读取授权不能上传', async () => {
    await expect(
      adapter('file:asset:upload').current('read'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      adapter('file:asset:read').current('upload'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(adapter('file:asset:page').current('read')).resolves.toEqual({
      tenantId: '1',
      userId: '1',
    });
  });
});
