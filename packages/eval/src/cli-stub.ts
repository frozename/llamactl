#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnServer, waitForHealth, killServer } from "./server.js";
import { runThroughput } from "./runners/throughput.js";

const [, , modelRel, ubArg = "512"] = process.argv;
if (!modelRel) {
  console.error("usage: cli-stub.ts <model-rel> [ub=512]");
  process.exit(2);
}
const ub = Number(ubArg) === 256 ? 256 : 512;
const LLAMA_CPP_BIN = process.env.LLAMA_CPP_BIN ?? "";
const LLAMA_CPP_MODELS = process.env.LLAMA_CPP_MODELS ?? "";
const DEV_STORAGE = process.env.DEV_STORAGE ?? "";
if (!LLAMA_CPP_BIN || !LLAMA_CPP_MODELS || !DEV_STORAGE) {
  console.error('env not set; run: eval "$(bun packages/cli/src/bin.ts env --eval)"');
  process.exit(2);
}

const modelPath = join(LLAMA_CPP_MODELS, modelRel);
if (!existsSync(modelPath)) {
  console.error(`missing model: ${modelPath}`);
  process.exit(3);
}

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(DEV_STORAGE, "eval", ts);
mkdirSync(outDir, { recursive: true });
const logPath = join(outDir, "server.log");

const server = await spawnServer(
  `${LLAMA_CPP_BIN}/llama-server`,
  {
    modelPath,
    port: 18181,
    ub,
  },
  logPath,
);

try {
  console.log(`==> waiting for ${server.url}/health`);
  await waitForHealth(server.url, server.proc);
  console.log("==> running throughput");
  const r = await runThroughput(server.url);
  const outFile = join(outDir, "throughput.json");
  await Bun.write(outFile, JSON.stringify(r, null, 2));
  console.log(`==> wrote ${outFile}`);
  console.log(
    `mean tps: ${r.mean_tps.toFixed(2)} (p10=${r.p10_tps.toFixed(2)} p90=${r.p90_tps.toFixed(2)})`,
  );
} finally {
  await killServer(server);
}
