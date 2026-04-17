import { describe, expect, test } from 'bun:test';
import { normalizeProfile, profileFromMemory, resolveProfile } from '../src/profile.js';

describe('profile.normalizeProfile', () => {
  test('canonicalises the three primary names', () => {
    expect(normalizeProfile('mac-mini-16g')).toBe('mac-mini-16g');
    expect(normalizeProfile('balanced')).toBe('balanced');
    expect(normalizeProfile('macbook-pro-48g')).toBe('macbook-pro-48g');
  });

  test('accepts friendly aliases', () => {
    expect(normalizeProfile('mini')).toBe('mac-mini-16g');
    expect(normalizeProfile('16g')).toBe('mac-mini-16g');
    expect(normalizeProfile('mbp')).toBe('macbook-pro-48g');
    expect(normalizeProfile('48g')).toBe('macbook-pro-48g');
    expect(normalizeProfile('best')).toBe('macbook-pro-48g');
  });

  test('returns null on empty and unknown', () => {
    expect(normalizeProfile(undefined)).toBeNull();
    expect(normalizeProfile('')).toBeNull();
    expect(normalizeProfile('m3-ultra-500g')).toBeNull();
  });
});

describe('profile.profileFromMemory', () => {
  test('<= 16 GiB -> mac-mini-16g', () => {
    expect(profileFromMemory(8 * 1024 ** 3)).toBe('mac-mini-16g');
    expect(profileFromMemory(16 * 1024 ** 3)).toBe('mac-mini-16g');
  });
  test('<= 32 GiB -> balanced', () => {
    expect(profileFromMemory(24 * 1024 ** 3)).toBe('balanced');
    expect(profileFromMemory(32 * 1024 ** 3)).toBe('balanced');
  });
  test('> 32 GiB -> macbook-pro-48g', () => {
    expect(profileFromMemory(48 * 1024 ** 3)).toBe('macbook-pro-48g');
    expect(profileFromMemory(96 * 1024 ** 3)).toBe('macbook-pro-48g');
  });
  test('null memory defaults to the most capable profile', () => {
    expect(profileFromMemory(null)).toBe('macbook-pro-48g');
  });
});

describe('profile.resolveProfile', () => {
  test('explicit override wins over detection', () => {
    expect(
      resolveProfile({ LLAMA_CPP_MACHINE_PROFILE: 'mac-mini-16g' } as NodeJS.ProcessEnv),
    ).toBe('mac-mini-16g');
  });
  test('alias in env is normalised', () => {
    expect(
      resolveProfile({ LLAMA_CPP_MACHINE_PROFILE: 'mini' } as NodeJS.ProcessEnv),
    ).toBe('mac-mini-16g');
  });
});
