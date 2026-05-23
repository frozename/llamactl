import { describe, test, expect } from 'bun:test';
import { projectAdmissionHeadroom } from '../src/policy.js';

describe('projectAdmissionHeadroom — measuredPeakMb integration', () => {
  test('uses measured peak with 1.05 bump instead of declared × safetyFactor', () => {
    // declared 7 GiB × 1.3 = 9.1 → projected 32 - 9.1 = 22.9 (allow, source=declared)
    // measured 10240 MB × 1.05 / 1024 = 10.5 → projected 32 - 10.5 = 21.5 (allow, source=measured)
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 32,
      expectedMemoryGiB: 7,
      headroomMinGiB: 4,
      safetyFactor: 1.3,
      measuredPeakMb: 10240,
    });
    expect(result.allowed).toBe(true);
    expect(result.source).toBe('measured');
    expect(result.projectedFreeGiB).toBeCloseTo(32 - (10240 * 1.05) / 1024, 5);
  });

  test('measured source can deny when declared alone would allow', () => {
    // declared 7 GiB × 1.3 → 10 - 9.1 = 0.9 > headroom 0.5 → declared would allow
    // measured 10240 MB × 1.05 / 1024 = 10.5 → 10 - 10.5 = -0.5 < 0.5 → deny
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 10,
      expectedMemoryGiB: 7,
      headroomMinGiB: 0.5,
      safetyFactor: 1.3,
      measuredPeakMb: 10240,
    });
    expect(result.allowed).toBe(false);
    expect(result.source).toBe('measured');
    if (!result.allowed) expect(result.reason).toBe('projected_free_below_headroom');
  });

  test('falls back to declared × safetyFactor when measuredPeakMb absent', () => {
    // 32 - 7 × 1.3 = 22.9
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 32,
      expectedMemoryGiB: 7,
      headroomMinGiB: 4,
      safetyFactor: 1.3,
    });
    expect(result.source).toBe('declared');
    expect(result.projectedFreeGiB).toBeCloseTo(32 - 7 * 1.3, 5);
  });

  test('measured source propagates through compressor deny path', () => {
    // measured allow on headroom, but compressor is over threshold
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 32,
      expectedMemoryGiB: 7,
      headroomMinGiB: 2,
      measuredPeakMb: 5120, // 5 GiB × 1.05 = 5.25 → projected 32-5.25=26.75 > 2 → headroom ok
      currentCompressorGiB: 3,
      compressorMaxGiB: 2, // compressor over threshold → deny
    });
    expect(result.allowed).toBe(false);
    expect(result.source).toBe('measured');
    if (!result.allowed) expect(result.reason).toBe('compressor_above_threshold');
  });

  test('measured allow propagates source on success path', () => {
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 64,
      expectedMemoryGiB: 7,
      headroomMinGiB: 4,
      measuredPeakMb: 8192, // 8 GiB × 1.05 = 8.4 → projected 64-8.4=55.6
    });
    expect(result.allowed).toBe(true);
    expect(result.source).toBe('measured');
  });
});
