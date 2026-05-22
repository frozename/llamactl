import { describe, expect, test } from 'bun:test';
import {
  classifyFleetPressure,
  projectAdmissionHeadroom,
} from '../../../fleet-supervisor/src/policy.js';

describe('fleet supervisor policy', () => {
  test('classifies HIGH pressure when free pages are low and compressor is high for N ticks', () => {
    const history = [
      { freeMb: 120, compressorMb: 1800 },
      { freeMb: 110, compressorMb: 1900 },
      { freeMb: 95,  compressorMb: 2100 },
    ];
    expect(
      classifyFleetPressure(history, { freeMb: 128, compressorMb: 1500, consecutiveTicks: 3 }),
    ).toEqual({ pressure: 'HIGH' });
  });

  test('classifies NORMAL pressure when fewer than N consecutive ticks are hot', () => {
    const history = [
      { freeMb: 500, compressorMb: 400 },
      { freeMb: 110, compressorMb: 1900 },
      { freeMb: 95,  compressorMb: 2100 },
    ];
    expect(
      classifyFleetPressure(history, { freeMb: 128, compressorMb: 1500, consecutiveTicks: 3 }),
    ).toEqual({ pressure: 'NORMAL' });
  });

  test('projects admission headroom and rejects under threshold', () => {
    expect(
      projectAdmissionHeadroom({
        currentFreeGiB: 18,
        expectedMemoryGiB: 12,
        headroomMinGiB: 8,
        safetyFactor: 1.3,
      }),
    ).toEqual({
      projectedFreeGiB: 18 - 12 * 1.3,
      allowed: false,
      reason: 'projected_free_below_headroom',
    });
  });

  test('projects admission headroom and allows when above threshold', () => {
    expect(
      projectAdmissionHeadroom({
        currentFreeGiB: 40,
        expectedMemoryGiB: 12,
        headroomMinGiB: 8,
        safetyFactor: 1.3,
      }),
    ).toEqual({
      projectedFreeGiB: 40 - 12 * 1.3,
      allowed: true,
    });
  });
});
