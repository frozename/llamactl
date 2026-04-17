import { describe, expect, test } from 'bun:test';
import { quantFromRel } from '../src/quant.js';

describe('quantFromRel', () => {
  test.each([
    ['gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf', 'q8'],
    ['foo/bar-UD-Q6_K_XL.gguf', 'q6'],
    ['foo/bar-UD-Q5_K_XL.gguf', 'q5'],
    ['foo/bar-UD-Q4_K_M.gguf', 'q4m'],
    ['foo/bar-UD-Q4_K_XL.gguf', 'q4'],
    ['foo/bar-UD-Q3_K_S.gguf', 'q3s'],
    ['foo/bar-UD-Q3_K_M.gguf', 'q3m'],
    ['foo/bar-UD-Q3_K_XL.gguf', 'q3xl'],
    ['foo/bar-UD-Q2_K_XL.gguf', 'q2'],
    ['foo/bar-MXFP4_MOE.gguf', 'mxfp4'],
    ['foo/bar-Q4_K_M.gguf', 'q4km'],
    ['foo/bar-Q5_K_M.gguf', 'q5km'],
    ['foo/something-weird.gguf', 'custom'],
  ] as const)('%s -> %s', (rel, expected) => {
    expect(quantFromRel(rel)).toBe(expected);
  });
});
