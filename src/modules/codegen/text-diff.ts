type Line = { kind: ' ' | '+' | '-'; text: string };

/** 有限内存的行差异；先剔除公共首尾，再对变更区做 LCS，输出三行上下文的统一差异。 */
export function textDiff(path: string, before: string, after: string): string {
  if (before === after) return '';
  const split = (s: string) =>
    s === '' ? [] : s.replace(/\n$/, '').split('\n');
  const a = split(before),
    b = split(after);
  let head = 0,
    tail = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const x = a.slice(head, a.length - tail),
    y = b.slice(head, b.length - tail);
  const ops: Line[] = a.slice(0, head).map((text) => ({ kind: ' ', text }));
  if ((x.length + 1) * (y.length + 1) <= 2000000) {
    const width = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        lcs[i * width + j] =
          x[i] === y[j]
            ? 1 + lcs[(i + 1) * width + j + 1]
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    let i = 0,
      j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        ops.push({ kind: ' ', text: x[i++] });
        j++;
      } else if (
        i < x.length &&
        (j === y.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])
      )
        ops.push({ kind: '-', text: x[i++] });
      else ops.push({ kind: '+', text: y[j++] });
    }
  } else {
    ops.push(
      ...x.map((text): Line => ({ kind: '-', text })),
      ...y.map((text): Line => ({ kind: '+', text })),
    );
  }
  ops.push(
    ...a.slice(a.length - tail).map((text): Line => ({ kind: ' ', text })),
  );
  const eofChanged = before.endsWith('\n') !== after.endsWith('\n');
  if (eofChanged && ops.at(-1)?.kind === ' ') {
    const last = ops.pop()!;
    ops.push({ kind: '-', text: last.text }, { kind: '+', text: last.text });
  }
  const ranges: [number, number][] = [];
  for (let i = 0; i < ops.length; i++)
    if (ops[i].kind !== ' ') {
      const start = Math.max(0, i - 3),
        end = Math.min(ops.length, i + 4);
      const previous = ranges.at(-1);
      if (previous && start <= previous[1]) previous[1] = end;
      else ranges.push([start, end]);
    }
  const oldPosition = [0],
    newPosition = [0];
  for (const op of ops) {
    oldPosition.push(oldPosition.at(-1)! + (op.kind === '+' ? 0 : 1));
    newPosition.push(newPosition.at(-1)! + (op.kind === '-' ? 0 : 1));
  }
  const output = [`--- a/${path}`, `+++ b/${path}`];
  for (const [start, end] of ranges) {
    const oldCount = oldPosition[end] - oldPosition[start],
      newCount = newPosition[end] - newPosition[start];
    output.push(
      `@@ -${oldPosition[start] + (oldCount ? 1 : 0)},${oldCount} +${newPosition[start] + (newCount ? 1 : 0)},${newCount} @@`,
    );
    for (let i = start; i < end; i++) {
      const op = ops[i];
      output.push(op.kind + op.text);
      if (
        (op.kind !== '+' &&
          oldPosition[i + 1] === a.length &&
          !before.endsWith('\n')) ||
        (op.kind !== '-' &&
          newPosition[i + 1] === b.length &&
          !after.endsWith('\n'))
      )
        output.push('\\ No newline at end of file');
    }
  }
  return output.join('\n') + '\n';
}
