import { describe, expect, test } from 'bun:test';
import {
  discoveryCacheFile,
  fileSizeFromTree,
  humanSize,
  hfEnabled,
  mmprojFileForRepo,
  modelInfoCacheFile,
  repoTreeCacheFile,
  siblingForFile,
} from '../src/hf.js';
import type { HFModelInfo, HFTree } from '../src/schemas.js';

describe('hf.hfEnabled', () => {
  test('default / unset -> true', () => {
    expect(hfEnabled({})).toBe(true);
  });
  test('off / none / local / false / FALSE / 0 disable', () => {
    for (const raw of ['off', 'none', 'local', 'false', 'FALSE', '0']) {
      expect(hfEnabled({ LOCAL_AI_RECOMMENDATIONS_SOURCE: raw })).toBe(false);
    }
  });
});

describe('hf.humanSize', () => {
  test.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [1_048_576, '1.0 MiB'],
    [3_221_225_472, '3.0 GiB'],
    [18_767_229_472, '17.5 GiB'],
    [null, '0 B'],
    [undefined, '0 B'],
  ])('%p -> %s', (input, expected) => {
    expect(humanSize(input as number | null | undefined)).toBe(expected);
  });
  test('non-finite -> n/a', () => {
    expect(humanSize(Number.NaN)).toBe('n/a');
    expect(humanSize(Number.POSITIVE_INFINITY)).toBe('n/a');
  });
});

describe('hf cache filename helpers', () => {
  test('slash-safe repo id', () => {
    expect(modelInfoCacheFile('/tmp/rt', 'unsloth/foo')).toBe(
      '/tmp/rt/hf-model-info-unsloth__foo.json',
    );
    expect(repoTreeCacheFile('/tmp/rt', 'unsloth/foo')).toBe(
      '/tmp/rt/hf-tree-unsloth__foo.json',
    );
  });
  test('discovery key bakes in limit + sanitized search', () => {
    expect(discoveryCacheFile('/tmp/rt', 'unsloth', 24, 'GGUF')).toBe(
      '/tmp/rt/hf-discovery-unsloth-GGUF-24.json',
    );
    expect(discoveryCacheFile('/tmp/rt', 'unsloth', 12, 'GGUF 2-bit')).toBe(
      '/tmp/rt/hf-discovery-unsloth-GGUF_2-bit-12.json',
    );
  });
});

describe('hf payload helpers', () => {
  const info: HFModelInfo = {
    id: 'unsloth/demo',
    siblings: [
      { rfilename: 'demo-UD-Q4_K_XL.gguf' },
      { rfilename: 'mmproj-BF16.gguf' },
      { rfilename: 'nested/demo-subdir-Q8_0.gguf' },
    ],
  };

  test('mmprojFileForRepo picks the mmproj sibling', () => {
    expect(mmprojFileForRepo(info)).toBe('mmproj-BF16.gguf');
  });
  test('siblingForFile resolves bare filenames via suffix match', () => {
    const s = siblingForFile(info, 'demo-subdir-Q8_0.gguf');
    expect(s?.rfilename).toBe('nested/demo-subdir-Q8_0.gguf');
  });
  test('siblingForFile honours explicit paths', () => {
    const s = siblingForFile(info, 'nested/demo-subdir-Q8_0.gguf');
    expect(s?.rfilename).toBe('nested/demo-subdir-Q8_0.gguf');
  });

  const tree: HFTree = [
    { path: 'demo-UD-Q4_K_XL.gguf', size: 1000, lfs: { size: 18_767_229_472 } },
    { path: 'mmproj-BF16.gguf', size: 200_000_000 },
  ];
  test('fileSizeFromTree prefers LFS size over pointer size', () => {
    expect(fileSizeFromTree(tree, 'demo-UD-Q4_K_XL.gguf')).toBe(18_767_229_472);
  });
  test('fileSizeFromTree falls back to plain size when no LFS', () => {
    expect(fileSizeFromTree(tree, 'mmproj-BF16.gguf')).toBe(200_000_000);
  });
  test('fileSizeFromTree null when file is absent', () => {
    expect(fileSizeFromTree(tree, 'missing.gguf')).toBeNull();
  });
});
