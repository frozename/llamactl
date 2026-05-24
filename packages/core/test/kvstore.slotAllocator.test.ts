import { expect, test } from 'bun:test';
import { SlotAllocator } from '../src/kvstore/index.js';

test('single-slot mode acquires slot 0 and blocks until release', () => {
  const allocator = new SlotAllocator(1);
  const first = allocator.acquire();
  expect(first?.slotId).toBe(0);
  expect(allocator.inUse()).toEqual([0]);

  const second = allocator.acquire();
  expect(second).toBeNull();

  first?.release();
  expect(allocator.inUse()).toEqual([]);

  const third = allocator.acquire();
  expect(third?.slotId).toBe(0);
});

test('multi-slot mode uses lowest free slot and reuses released slots', () => {
  const allocator = new SlotAllocator(3);
  const a = allocator.acquire();
  const b = allocator.acquire();
  const c = allocator.acquire();
  const d = allocator.acquire();

  expect(a?.slotId).toBe(0);
  expect(b?.slotId).toBe(1);
  expect(c?.slotId).toBe(2);
  expect(d).toBeNull();
  expect(allocator.inUse()).toEqual([0, 1, 2]);

  b?.release();
  expect(allocator.inUse()).toEqual([0, 2]);

  const reused = allocator.acquire();
  expect(reused?.slotId).toBe(1);
  expect(allocator.inUse()).toEqual([0, 1, 2]);
});

test('release callback is idempotent', () => {
  const allocator = new SlotAllocator(2);
  const first = allocator.acquire();
  const second = allocator.acquire();
  expect(first?.slotId).toBe(0);
  expect(second?.slotId).toBe(1);
  expect(allocator.acquire()).toBeNull();

  second?.release();
  second?.release();
  expect(allocator.inUse()).toEqual([0]);

  const next = allocator.acquire();
  expect(next?.slotId).toBe(1);
});
