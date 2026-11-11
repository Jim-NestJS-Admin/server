import { textDiff } from './text-diff.js';

describe('统一文本差异', () => {
  it('仅包含实际变更及上下文，远处不变内容不重复输出', () => {
    const before =
      Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n') + '\n';
    const after = before
      .replace('line-10\n', 'changed-10\n')
      .replace('line-30\n', 'changed-30\n');
    const diff = textDiff('sample.ts', before, after);
    expect(diff).toContain('--- a/sample.ts\n+++ b/sample.ts\n');
    expect(diff).toContain('-line-10\n+changed-10');
    expect(diff).toContain('-line-30\n+changed-30');
    expect(diff).not.toContain('line-0\n');
    expect(diff).not.toContain('line-20\n');
    expect(diff.match(/^@@/gm)).toHaveLength(2);
  });
  it('新增、删除、文件尾换行和空文件均有正确标记', () => {
    expect(textDiff('x', '', 'first\n')).toContain('@@ -0,0 +1,1 @@\n+first\n');
    expect(textDiff('x', 'first\n', '')).toContain('@@ -1,1 +0,0 @@\n-first\n');
    expect(textDiff('x', 'first', 'first\n')).toContain(
      '-first\n\\ No newline at end of file\n+first',
    );
    expect(textDiff('x', 'same\n', 'same\n')).toBe('');
  });
});
