#!/usr/bin/env bun
import { join } from "node:path";

import { runThroughput } from "./runners/throughput.js";
import { existsSync, mkdirSync } from "./safe-fs.js";
import { killServer, spawnServer, waitForHealth } from "./server.js";

const [, , modelRel, ubArg = "512"] = process.argv;
if (!modelRel) {
  process.stderr.write("usage: cli-stub.ts <model-rel> [ub=512]\n");
  process.exit(2);
}
const ub = Number(ubArg) === 256 ? 256 : 512;
const LLAMA_CPP_BIN = process.env.LLAMA_CPP_BIN ?? "";
const LLAMA_CPP_MODELS = process.env.LLAMA_CPP_MODELS ?? "";
const DEV_STORAGE = process.env.DEV_STORAGE ?? "";
if (!LLAMA_CPP_BIN || !LLAMA_CPP_MODELS || !DEV_STORAGE) {
  process.stderr.write('env not set; run: eval "$(bun packages/cli/src/bin.ts env --eval)"\n');
  process.exit(2);
}

const modelPath = join(LLAMA_CPP_MODELS, modelRel);
if (!existsSync(modelPath)) {
  process.stderr.write(`missing model: ${modelPath}\n`);
  process.exit(3);
}

const ts = new Date().toISOString().replaceAll(/[:.]/g, "-");
const outDir = join(DEV_STORAGE, "eval", ts);
mkdirSync(outDir, { recursive: true });
const logPath = join(outDir, "server.log");

const server = spawnServer(
  `${LLAMA_CPP_BIN}/llama-server`,
  {
    modelPath,
    port: 18181,
    ub,
  },
  logPath,
);

try {
  process.stdout.write(`==> waiting for ${server.url}/health\n`);
  await waitForHealth(server.url, server.proc);
  process.stdout.write("==> running throughput\n");
  const r = await runThroughput(server.url);
  const outFile = join(outDir, "throughput.json");
  await Bun.write(outFile, JSON.stringify(r, null, 2));
  process.stdout.write(`==> wrote ${outFile}\n`);
  process.stdout.write(
    `mean tps: ${r.mean_tps.toFixed(2)} (p10=${r.p10_tps.toFixed(2)} p90=${r.p90_tps.toFixed(2)})`,
  );
} finally {
  await killServer(server);
}
