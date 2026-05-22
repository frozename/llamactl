import { describe, expect, test } from 'bun:test';
import { classifyFleetPressure, projectAdmissionHeadroom } from '../src/policy.js';

describe('classifyFleetPressure', () => {
  test('HIGH when all ticks breach both thresholds', () => {
    const history = [
      { freeMb: 120, compressorMb: 1800 },
      { freeMb: 110, compressorMb: 1900 },
      { freeMb: 95,  compressorMb: 2100 },
    ];
    expect(classifyFleetPressure(history, { freeMb: 128, compressorMb: 1500, consecutiveTicks: 3 }))
      .toEqual({ pressure: 'HIGH' });
  });

  test('NORMAL when only 2 of 3 ticks breach', () => {
    const history = [
      { freeMb: 200, compressorMb: 1000 },
      { freeMb: 110, compressorMb: 1900 },
      { freeMb: 95,  compressorMb: 2100 },
    ];
    expect(classifyFleetPressure(history, { freeMb: 128, compressorMb: 1500, consecutiveTicks: 3 }))
      .toEqual({ pressure: 'NORMAL' });
  });

  test('NORMAL when free pages are below threshold but compressor is fine', () => {
    const history = [
      { freeMb: 50, compressorMb: 500 },
      { freeMb: 40, compressorMb: 600 },
      { freeMb: 30, compressorMb: 700 },
    ];
    expect(classifyFleetPressure(history, { freeMb: 128, compressorMb: 1500, consecutiveTicks: 3 }))
      .toEqual({ pressure: 'NORMAL' });
  });

  test('NORMAL when history is shorter than consecutiveTicks', () => {
    const history = [{ freeMb: 50, compressorMb: 2000 }];
    expect(classifyFleetPressure(history, { freeMb: 128, compressorMb: 1500, consecutiveTicks: 3 }))
      .toEqual({ pressure: 'NORMAL' });
  });
});

describe('projectAdmissionHeadroom', () => {
  test('rejects when projected free drops below headroom minimum', () => {
    // 18 - (12 * 1.3) = 18 - 15.6 = 2.4 < 8 → reject
    expect(projectAdmissionHeadroom({
      currentFreeGiB: 18,
      expectedMemoryGiB: 12,
      headroomMinGiB: 8,
      safetyFactor: 1.3,
    })).toEqual({
      projectedFreeGiB: expect.closeTo(2.4, 5),
      allowed: false,
      reason: 'projected_free_below_headroom',
    });
  });

  test('allows when projected free exceeds headroom minimum', () => {
    // 32 - (8 * 1.3) = 32 - 10.4 = 21.6 > 8 → allow
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 32,
      expectedMemoryGiB: 8,
      headroomMinGiB: 8,
      safetyFactor: 1.3,
    });
    expect(result.allowed).toBe(true);
    expect(result.projectedFreeGiB).toBeCloseTo(21.6, 5);
    expect('reason' in result).toBe(false);
  });

  test('defaults safetyFactor to 1.3 when omitted', () => {
    const withExplicit = projectAdmissionHeadroom({ currentFreeGiB: 20, expectedMemoryGiB: 5, headroomMinGiB: 4, safetyFactor: 1.3 });
    const withDefault  = projectAdmissionHeadroom({ currentFreeGiB: 20, expectedMemoryGiB: 5, headroomMinGiB: 4 });
    expect(withDefault.projectedFreeGiB).toBeCloseTo(withExplicit.projectedFreeGiB, 10);
  });
});
