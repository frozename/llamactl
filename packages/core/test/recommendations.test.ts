import { describe, expect, test } from 'bun:test';
import { recommendationsForProfile } from '../src/recommendations.js';

/**
 * Recommendation-ladder safety: the rels picked for each machine
 * profile must actually fit that profile's memory envelope.
 *
 * The existence of a recommendation is a contract — operators trust
 * `llamactl recommendations` enough to wire the rel into a workload
 * manifest unmodified. A row that picks an OOM-bound quant is a
 * silent footgun: the bench passes (transient process), `apply -f`
 * starts the server, the workload phase reports Running, and then
 * `/v1/chat/completions` fails with `Compute error.` only when a real
 * inference request hits the kernel and Metal exceeds its working-set
 * cap. By that point the operator has already shaped a workload around
 * the wrong rel.
 *
 * The 16 GiB profile gets a particularly tight envelope: Apple Silicon
 * caps `recommendedMaxWorkingSetSize` at ~12.7 GB on a 16 GiB M-class
 * chip — that's the GPU residency ceiling, not free RAM. Anything
 * larger than that for the model weights alone is unworkable. We carry
 * a small fudge-factor below for KV cache + Metal compute buffers.
 */

const MAX_MODEL_SIZE_BY_PROFILE_GB: Record<string, number> = {
  'mac-mini-16g': 11.5,
  // balanced ≈ 32 GiB profile; Metal cap there is ~24 GB. Leave room for KV/buffers.
  balanced: 22,
  // macbook-pro-48g — Metal cap ~36 GB; allow up to ~32 for the rel.
  'macbook-pro-48g': 32,
};

/**
 * Approximate file size in bytes derived from the rel name's quant
 * tag + the family's known parameter count. Cheap heuristic — we
 * don't HTTP-fetch HF for this test; the catalog ladder shouldn't
 * depend on network. Tuned against the actual unsloth GGUF sizes
 * for the families we recommend today.
 */
function estimateRelSizeGb(rel: string): number {
  const fname = rel.split('/').pop() ?? rel;
  // Family base parameter counts (B params).
  let paramsB: number;
  if (rel.startsWith('Qwen3.6-35B-A3B-GGUF/')) paramsB = 35;
  else if (rel.startsWith('Qwen3.5-27B-GGUF/')) paramsB = 27;
  else if (rel.startsWith('gemma-4-E4B-it-GGUF/')) paramsB = 7.5;
  else if (rel.startsWith('gemma-4-26B-A4B-it-GGUF/')) paramsB = 26;
  else if (rel.startsWith('gemma-4-31B-it-GGUF/')) paramsB = 31;
  else throw new Error(`unknown family for size estimate: ${rel}`);

  // Bits per weight by quant tag, biased high so we err toward
  // marking a recommendation as too-large rather than too-small.
  let bpw: number;
  if (/IQ1_M/.test(fname)) bpw = 2.3;
  else if (/IQ2_(M|XS|XXS)/.test(fname)) bpw = 2.6;
  else if (/Q2_K/.test(fname)) bpw = 2.85;
  else if (/IQ3|Q3_K_S/.test(fname)) bpw = 3.5;
  else if (/Q3_K_M/.test(fname)) bpw = 3.85;
  else if (/Q3_K_XL/.test(fname)) bpw = 4.0;
  else if (/IQ4|Q4_0|Q4_K_S/.test(fname)) bpw = 4.65;
  else if (/Q4_K_M|Q4_K_XL|Q4_1/.test(fname)) bpw = 5.0;
  else if (/Q5_K/.test(fname)) bpw = 5.85;
  else if (/Q6_K/.test(fname)) bpw = 6.85;
  else if (/Q8_0|Q8_K_XL/.test(fname)) bpw = 8.5;
  else if (/BF16|F16/.test(fname)) bpw = 16;
  else throw new Error(`unknown quant for size estimate: ${rel}`);

  return (paramsB * 1e9 * bpw) / 8 / 1e9;
}

describe('recommendationsForProfile — fit-envelope guarantees', () => {
  for (const profile of ['mac-mini-16g', 'balanced', 'macbook-pro-48g'] as const) {
    test(`every rel for ${profile} fits the profile's max model size`, () => {
      const rows = recommendationsForProfile(profile);
      const ceiling = MAX_MODEL_SIZE_BY_PROFILE_GB[profile]!;
      for (const row of rows) {
        const sizeGb = estimateRelSizeGb(row.rel);
        if (sizeGb > ceiling) {
          throw new Error(
            `${profile}/${row.target}: rel '${row.rel}' is ~${sizeGb.toFixed(1)} GB, ` +
              `over the ${ceiling} GB ceiling for this profile`,
          );
        }
      }
    });
  }

  test('mac-mini-16g qwen slot picks IQ2_M (proven-fit on M4)', () => {
    const rows = recommendationsForProfile('mac-mini-16g');
    const qwen = rows.find((r) => r.target === 'qwen');
    expect(qwen).toBeDefined();
    expect(qwen!.rel).toBe('Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-IQ2_M.gguf');
  });

  test('mac-mini-16g qwen27 slot picks the 16g-fit rel, not Q5_K_XL', () => {
    const rows = recommendationsForProfile('mac-mini-16g');
    const qwen27 = rows.find((r) => r.target === 'qwen27');
    expect(qwen27).toBeDefined();
    expect(qwen27!.rel).toBe('Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-IQ2_M.gguf');
  });

  test('balanced + macbook-pro-48g still get the larger qwen rels', () => {
    const balancedQwen = recommendationsForProfile('balanced').find((r) => r.target === 'qwen');
    expect(balancedQwen!.rel).toBe('Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf');
    const proQwen = recommendationsForProfile('macbook-pro-48g').find((r) => r.target === 'qwen');
    expect(proQwen!.rel).toBe('Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf');
    const proQwen27 = recommendationsForProfile('macbook-pro-48g').find((r) => r.target === 'qwen27');
    expect(proQwen27!.rel).toBe('Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf');
  });
});
