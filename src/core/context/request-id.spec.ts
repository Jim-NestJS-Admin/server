import type { IncomingMessage } from 'node:http';
import { resolveRequestId, type RequestWithId } from './request-id.js';

const req = (h?: string) =>
  ({
    headers: h === undefined ? {} : { 'x-request-id': h },
  }) as unknown as RequestWithId & IncomingMessage;

describe('resolveRequestId', () => {
  it('合法的上游请求 ID 沿用', () => {
    expect(resolveRequestId(req('abc-123_XYZ.9'))).toBe('abc-123_XYZ.9');
  });
  it('没有或不合法时生成新的 UUID（防日志注入、超长值）', () => {
    const uuid = /^[0-9a-f-]{36}$/;
    expect(resolveRequestId(req())).toMatch(uuid);
    expect(resolveRequestId(req('bad id\nINJECT'))).toMatch(uuid);
    expect(resolveRequestId(req('x'.repeat(65)))).toMatch(uuid);
    expect(resolveRequestId(req('short'))).toMatch(uuid);
  });
  it('同一个请求多次调用结果一致（日志和上下文用同一个 ID）', () => {
    const r = req();
    expect(resolveRequestId(r)).toBe(resolveRequestId(r));
  });
});
