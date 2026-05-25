import { expect, test } from 'bun:test';
import { canonicalRequestSha, boundaryNaiveBytePrefixSha } from '../../src/cache-identity/canonical.js';

test('canonicalRequestSha is stable across JSON key reorder', () => {
  const left = '{"b":2,"a":1,"nested":{"y":2,"x":1}}';
  const right = '{"a":1,"nested":{"x":1,"y":2},"b":2}';
  expect(canonicalRequestSha(left)).toBe(canonicalRequestSha(right));
});

test('boundaryNaiveBytePrefixSha changes when bytes change', () => {
  expect(boundaryNaiveBytePrefixSha('{"a":1}')).not.toBe(boundaryNaiveBytePrefixSha('{"a": 1}'));
});

test('canonicalRequestSha and boundaryNaiveBytePrefixSha are stable across runs', () => {
  const payload = '{"z":3,"a":[2,1]}';
  const canonical = canonicalRequestSha(payload);
  const boundary = boundaryNaiveBytePrefixSha(payload);
  expect(canonicalRequestSha(payload)).toBe(canonical);
  expect(canonicalRequestSha(payload)).toBe(canonical);
  expect(boundaryNaiveBytePrefixSha(payload)).toBe(boundary);
  expect(boundaryNaiveBytePrefixSha(payload)).toBe(boundary);
});

test('canonicalRequestSha ignores x_omlx_request_handle', () => {
  const withoutHandle = JSON.stringify({
    model: 'mlx-community/Qwen3-8B-MLX-4bit',
    messages: [{ role: 'user', content: 'hello' }],
  });
  const withHandle = JSON.stringify({
    model: 'mlx-community/Qwen3-8B-MLX-4bit',
    messages: [{ role: 'user', content: 'hello' }],
    x_omlx_request_handle: 'req-123',
  });
  expect(canonicalRequestSha(withoutHandle)).toBe(canonicalRequestSha(withHandle));
});

test('canonicalRequestSha ignores x_omlx_restore_epoch', () => {
  const withoutEpoch = JSON.stringify({
    model: 'mlx-community/Qwen3-8B-MLX-4bit',
    messages: [{ role: 'user', content: 'hello' }],
  });
  const withEpoch = JSON.stringify({
    model: 'mlx-community/Qwen3-8B-MLX-4bit',
    messages: [{ role: 'user', content: 'hello' }],
    x_omlx_restore_epoch: 'epoch-abc',
  });
  expect(canonicalRequestSha(withoutEpoch)).toBe(canonicalRequestSha(withEpoch));
});

test('canonicalRequestSha still distinguishes unrelated fields', () => {
  const baseline = JSON.stringify({
    model: 'mlx-community/Qwen3-8B-MLX-4bit',
    messages: [{ role: 'user', content: 'hello' }],
  });
  const changed = JSON.stringify({
    model: 'mlx-community/Qwen3-8B-MLX-4bit',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0,
  });
  expect(canonicalRequestSha(baseline)).not.toBe(canonicalRequestSha(changed));
});
