// Seeds one realistic tuned bench record into the hermetic test
// profile's runtime dir so test/shell-smoke.zsh's bench reads exercise
// the real read/format paths instead of depending on the operator's
// live $DEV_STORAGE.
//
// Hard guard: writes only when the resolved LOCAL_AI_RUNTIME_DIR sits
// inside $LLAMACTL_TEST_PROFILE. Outside that guard this prints a SKIP
// line and exits 0 — a real $DEV_STORAGE is never touched.
//
// Stdout protocol consumed by shell-smoke.zsh:
//   SEEDED_REL=<rel>      one line per profile row written this run
//   SHOW_REL=<rel>        a record exists for `bench show current`'s key
//   COMPARE_REL=<rel>     a tuned row exists for `bench compare all all`
//   COMPARE_PROFILE=<p>   that row's tuned profile name

import { resolve, sep } from "node:path";

import { benchCompare } from "../../packages/core/src/bench/compare.js";
import { defaultModeForRel, machineLabel } from "../../packages/core/src/bench/mode.js";
import { writeBenchProfile } from "../../packages/core/src/bench/runner.js";
import {
  benchHistoryFile,
  benchProfileFile,
  findLatestProfile,
  findLegacyProfile,
  readBenchHistory,
  readBenchProfiles,
} from "../../packages/core/src/bench/store.js";
import { resolveBuildId } from "../../packages/core/src/build.js";
import { listCatalog } from "../../packages/core/src/catalog.js";
import { ctxForModel } from "../../packages/core/src/ctx.js";
import { resolveEnv } from "../../packages/core/src/env.js";
import { resolveTarget } from "../../packages/core/src/target.js";

const SEEDED_PROFILE = "throughput";
const SEEDED_GEN_TS = "51.181301";
const SEEDED_PROMPT_TS = "766.668202";

const skip = (reason: string): never => {
  process.stdout.write(`SKIP ${reason}\n`);
  process.exit(0);
};

const testProfile = process.env["LLAMACTL_TEST_PROFILE"];
if (!testProfile) skip("LLAMACTL_TEST_PROFILE unset");

const resolved = resolveEnv();
const runtimeDir = resolve(resolved.LOCAL_AI_RUNTIME_DIR);
const profileRoot = resolve(testProfile);
if (runtimeDir !== profileRoot && !runtimeDir.startsWith(`${profileRoot}${sep}`)) {
  skip(`LOCAL_AI_RUNTIME_DIR=${runtimeDir} is outside LLAMACTL_TEST_PROFILE`);
}

const keyFor = (rel: string) => ({
  machine: machineLabel(resolved),
  rel,
  mode: defaultModeForRel(rel, resolved),
  ctx: ctxForModel(rel, resolved),
  build: resolveBuildId(resolved),
});

const hasRecord = (rel: string): boolean => {
  const rows = readBenchProfiles(benchProfileFile(resolved));
  return Boolean(findLatestProfile(rows, keyFor(rel)) ?? findLegacyProfile(rows, rel));
};

const seeded: string[] = [];
const seed = (rel: string): void => {
  writeBenchProfile(
    {
      ...keyFor(rel),
      profile: SEEDED_PROFILE,
      gen_ts: SEEDED_GEN_TS,
      prompt_ts: SEEDED_PROMPT_TS,
    },
    resolved,
  );
  seeded.push(rel);
};

const currentRel = resolveTarget("current");
if (currentRel && !hasRecord(currentRel)) seed(currentRel);

// `bench compare all all` only surfaces catalog rels — seed a builtin
// entry too so the tuned-record gate holds even when the resolved
// current model lives outside the catalog.
const catalogRel = listCatalog("builtin")[0]?.rel;
if (catalogRel && catalogRel !== currentRel && !hasRecord(catalogRel)) seed(catalogRel);

// Upserts above only run when a record was missing; if every record
// pre-existed but the append-only history is still empty, force one
// write so `bench history` has a row to format.
if (seeded.length === 0 && currentRel) {
  const history = readBenchHistory(benchHistoryFile(resolved));
  if (history.current.length === 0 && history.legacy.length === 0) seed(currentRel);
}

for (const rel of seeded) process.stdout.write(`SEEDED_REL=${rel}\n`);

if (currentRel && hasRecord(currentRel)) {
  process.stdout.write(`SHOW_REL=${currentRel}\n`);
}
const tuned = benchCompare().find((row) => row.tuned !== null);
if (tuned?.tuned) {
  process.stdout.write(`COMPARE_REL=${tuned.rel}\n`);
  process.stdout.write(`COMPARE_PROFILE=${tuned.tuned.profile}\n`);
}
