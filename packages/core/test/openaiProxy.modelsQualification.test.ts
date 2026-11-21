import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "../src/safe-fs.js";

// #518: the /v1/models `unavailable` and `declared` sibling arrays report
// the routing qualification stage — catalog rows overlaid with pin rows —
// not the raw catalog stage. `unavailable[].qualification.stage` and the
// declared-listing `experimental` flag both join `catalogQualificationStages`.
// DeclaredModelInfo has no `experimental` field at the base revision, so
// the widened views below keep these RED cases typechecking: they fail by
// assertion, never by an import or type error.

const MIMO_REL =
  "MiMo-V2.6-Flash-MOPD-GGUF-AesSedai/b6e95d58/BPW2.5/MiMo-V2.6-Flash-MOPD-BPW2.5-00001-of-00003.gguf";
const COLD_UNAVAILABLE_ROW =
  'cold-x\tCold X\tcold\tcustom\tcustom\tcold/x.gguf\torg/cold\tgguf\t{"availability":{"declared":"unavailable","reason":"r"}}';

function tempEnv(extra?: Record<string, string>): {
  env: ResolvedEnv;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-qual-"));
  return {
    env: resolveEnv({
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: dir,
      LLAMA_CPP_MODELS: join(dir, "models"),
      ...extra,
    }),
    dir,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  } satisfies { env: ResolvedEnv; dir: string; cleanup: () => void };
}

// LOCAL_AI_QUALIFICATION_OVERRIDES_FILE is read from process.env (it is
// not a ResolvedEnv key), so every case clears it to pin resolution at
// <runtimeDir>/qualification-overrides.tsv and restores it in finally.
function clearOverridesFileEnv(): () => void {
  const saved = process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"];
  delete process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"];
  return () => {
    if (saved === undefined) delete process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"];
    else process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"] = saved;
  };
}

function writePin(runtimeDir: string, rel: string, stage: string): void {
  writeFileSync(
    join(runtimeDir, "qualification-overrides.tsv"),
    `${rel}\tpin\t${stage}\tops\twhy\t2026-11-14T00:00:00Z\n`,
  );
}

function declaredSourceEntry(id: string): Record<string, unknown> {
  return {
    id,
    workload: "wl-declared",
    kind: "ModelHost",
    ownerNodeId: "local",
    state: "cold",
    autoLoadEligible: true,
  };
}

interface UnavailableListEntry {
  id: string;
  qualification?: { stage: string };
}

interface DeclaredListEntry {
  id: string;
  experimental?: true;
}

const unavailableEntries = (models: unknown): UnavailableListEntry[] | undefined =>
  (models as { unavailable?: UnavailableListEntry[] }).unavailable;

const declaredEntries = (models: unknown): DeclaredListEntry[] | undefined =>
  (models as { declared?: DeclaredListEntry[] }).declared;

describe("/v1/models qualification stages (#518)", () => {
  afterEach(() => {
    openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
    openaiProxy.setDeclaredModelSource(null);
  });

  test("an unavailable entry reports the pinned stage, not the catalog stage", () => {
    const restoreEnv = clearOverridesFileEnv();
    const t = tempEnv();
    try {
      writePin(t.dir, MIMO_REL, "validated");

      const entry = unavailableEntries(openaiProxy.listOpenAIModels(t.env))?.find(
        (e) => e.id === MIMO_REL,
      );

      expect(entry?.qualification).toEqual({ stage: "validated" });
    } finally {
      restoreEnv();
      t.cleanup();
    }
  });

  test("a pin stages an unavailable custom row the catalog never staged", () => {
    const restoreEnv = clearOverridesFileEnv();
    const t = tempEnv();
    try {
      writeFileSync(join(t.dir, "curated-models.tsv"), `${COLD_UNAVAILABLE_ROW}\n`);
      writePin(t.dir, "cold/x.gguf", "experimental");

      const entry = unavailableEntries(openaiProxy.listOpenAIModels(t.env))?.find(
        (e) => e.id === "cold/x.gguf",
      );

      expect(entry?.qualification).toEqual({ stage: "experimental" });
    } finally {
      restoreEnv();
      t.cleanup();
    }
  });

  test("an unpinned unavailable entry keeps its catalog stage", () => {
    const restoreEnv = clearOverridesFileEnv();
    const t = tempEnv();
    try {
      const entry = unavailableEntries(openaiProxy.listOpenAIModels(t.env))?.find(
        (e) => e.id === MIMO_REL,
      );

      expect(entry?.qualification).toEqual({ stage: "experimental" });
    } finally {
      restoreEnv();
      t.cleanup();
    }
  });

  test("a pin edit re-stages the unavailable entry without a restart", () => {
    const restoreEnv = clearOverridesFileEnv();
    const t = tempEnv();
    try {
      const epoch = new Date("2026-01-01T00:00:00.000Z");
      const findMimo = (): UnavailableListEntry | undefined =>
        unavailableEntries(openaiProxy.listOpenAIModels(t.env))?.find((e) => e.id === MIMO_REL);

      expect(findMimo()?.qualification).toEqual({ stage: "experimental" });

      const overridesFile = join(t.dir, "qualification-overrides.tsv");
      writeFileSync(overridesFile, `${MIMO_REL}\tpin\tcandidate\tops\twhy\t2026-11-14T00:00:00Z\n`);
      utimesSync(overridesFile, epoch, new Date(epoch.getTime() + 1_000));

      expect(findMimo()?.qualification).toEqual({ stage: "candidate" });
    } finally {
      restoreEnv();
      t.cleanup();
    }
  });

  test("a declared entry for an experimental rel carries experimental: true", () => {
    const restoreEnv = clearOverridesFileEnv();
    const t = tempEnv();
    try {
      openaiProxy.setDeclaredModelSource(() => [declaredSourceEntry("cold/declared-exp.gguf")]);
      writePin(t.dir, "cold/declared-exp.gguf", "experimental");

      const entry = declaredEntries(openaiProxy.listOpenAIModels(t.env))?.find(
        (e) => e.id === "cold/declared-exp.gguf",
      );

      expect(entry?.experimental).toBe(true);
    } finally {
      restoreEnv();
      t.cleanup();
    }
  });

  test("listServingOpenAIModels flags the declared experimental entry too", async () => {
    const restoreEnv = clearOverridesFileEnv();
    const t = tempEnv();
    try {
      openaiProxy.setDeclaredModelSource(() => [declaredSourceEntry("cold/declared-exp.gguf")]);
      writePin(t.dir, "cold/declared-exp.gguf", "experimental");

      const models = await openaiProxy.listServingOpenAIModels(t.env);
      const entry = declaredEntries(models)?.find((e) => e.id === "cold/declared-exp.gguf");

      expect(entry?.experimental).toBe(true);
    } finally {
      restoreEnv();
      t.cleanup();
    }
  });

  test("a non-experimental declared entry has no experimental key", () => {
    const restoreEnv = clearOverridesFileEnv();
    const t = tempEnv();
    try {
      openaiProxy.setDeclaredModelSource(() => [
        declaredSourceEntry("cold/declared-val.gguf"),
        declaredSourceEntry("cold/declared-plain.gguf"),
      ]);
      writePin(t.dir, "cold/declared-val.gguf", "validated");

      const declared = declaredEntries(openaiProxy.listOpenAIModels(t.env)) ?? [];
      const staged = declared.find((e) => e.id === "cold/declared-val.gguf");
      const unstaged = declared.find((e) => e.id === "cold/declared-plain.gguf");

      expect(staged).toBeDefined();
      expect(unstaged).toBeDefined();
      expect("experimental" in (staged ?? {})).toBe(false);
      expect("experimental" in (unstaged ?? {})).toBe(false);
    } finally {
      restoreEnv();
      t.cleanup();
    }
  });
});
