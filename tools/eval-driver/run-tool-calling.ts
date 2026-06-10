#!/usr/bin/env bun
// Standalone driver around packages/eval's runToolCalling().
// Usage: bun tools/eval-driver/run-tool-calling.ts --url http://127.0.0.1:8093 --out bench-results/tool-calling-<model>.json
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runToolCalling } from "../../packages/eval/src/runners/tool-calling.js";

function arg(flag: string, fallback?: string): string {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required flag: ${flag}`);
}

async function main() {
  const URL = arg("--url");
  const OUT = arg("--out");
  const label = arg("--label", URL);

  console.log(`url=${URL} label=${label}`);
  const t0 = Date.now();
  const result = await runToolCalling(URL);
  const wall_s = (Date.now() - t0) / 1000;

  const passes = result.prompts.filter((p) => p.score.score === 1).length;
  const total = result.prompts.length;
  console.log(`--- summary ---`);
  console.log(`url:              ${URL}`);
  console.log(`label:            ${label}`);
  console.log(`wall_s:           ${wall_s.toFixed(1)}`);
  console.log(
    `tool_call_score:  ${(result.tool_call_score * 100).toFixed(1)}%  (${passes}/${total})`,
  );
  console.log(`per-prompt:`);
  for (const p of result.prompts) {
    const s = p.score;
    const flag = s.score === 1 ? "✓" : "✗";
    const detail =
      s.score === 1
        ? ""
        : `(json=${s.valid_json} dec=${s.correct_decision} tool=${s.correct_tool} args=${s.args_match})`;
    console.log(`  ${flag} ${p.name.padEnd(36)} ${detail}`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ url: URL, label, wall_s, ...result }, null, 2));
  console.log(`wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
