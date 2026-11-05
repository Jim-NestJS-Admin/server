import { stableStringify } from './swagger.js';

describe('stableStringify', () => {
  it('键顺序不同的同一对象输出完全一样', () => {
    expect(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 }),
    );
  });
});
