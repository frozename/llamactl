import { describe, expect, test } from 'bun:test';
import { ENGINES, type EngineName } from '../../src/engines/index.js';

describe('engine registry', () => {
  test('registry contains llamacpp and omlx keys', () => {
    const keys: EngineName[] = Object.keys(ENGINES) as EngineName[];
    expect(keys).toContain('llamacpp');
    expect(keys).toContain('omlx');
  });

  test('every registered engine reports its own name', () => {
    for (const [key, adapter] of Object.entries(ENGINES)) {
      expect(adapter.name).toBe(key as EngineName);
    }
  });

  test('every adapter exposes validateSpec / prepareLaunch / buildBootCommand / probeReady / teardown', () => {
    for (const adapter of Object.values(ENGINES)) {
      expect(typeof adapter.validateSpec).toBe('function');
      expect(typeof adapter.prepareLaunch).toBe('function');
      expect(typeof adapter.buildBootCommand).toBe('function');
      expect(typeof adapter.probeReady).toBe('function');
      expect(typeof adapter.teardown).toBe('function');
    }
  });
});
