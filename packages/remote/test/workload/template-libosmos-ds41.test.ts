import { catalog } from "@llamactl/core";
import { ENGINES } from "@llamactl/core/engines";
import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { specForEngine } from "../../src/workload/modelhost-schema.js";
import {
  asRecord,
  carriers,
  expectArmGroup,
  fileClaimingName,
  filesClaimingNodePort,
  hostedModelRels,
  loadModelHostTemplate,
  modelRunsTargetingRel,
  RESERVED_PORTS,
  residencyGroupLabel,
  templateDocs,
} from "./template-arms.js";

/**
 * RED pins for frozename/llamactl#557 (S4): two libosmos DeepSeek
 * V4.1-Flash-1017 runtime-arm ModelHosts on z13 — D-O1 (UD-IQ1_M, port
 * 8085) and D-O2 (UD-IQ1_S, port 8092). Both boot the pinned
 * libosmos-934b51b932be osmos-api with the 3c6b0aeb256c evo picks and
 * the dspark-iq2xs drafter; osmos-api decodes greedily only (it 400s on
 * temperature/top_p), so no sampling flags may appear. Each arm pairs
 * with its committed-disabled llamacpp baseline on the shared rel and
 * stays on the exclusive z13-large-gpu residency group. The templates
 * do not exist yet, so every case fails on the missing file until the
 * GREEN slice lands them.
 */
const RT = "/home/alex/strix-halo-bench/runtimes/libosmos-934b51b932be/src/bin/osmos-api";
const RUNTIME_ARM = "libosmos-934b51b932be";
const IQ1M_REL =
  "DeepSeek-V4.1-Flash-1017-GGUF-unsloth/2688c0c3/UD-IQ1_M/DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00001-of-00005.gguf";
const IQ1S_REL =
  "DeepSeek-V4.1-Flash-1017-GGUF-unsloth/2688c0c3/UD-IQ1_S/DeepSeek-V4.1-Flash-1017-UD-IQ1_S-00001-of-00005.gguf";
const PICKS_M = "osmos-evo-1017/3c6b0aeb256c/picks/UD-IQ1_M/osmos-picks.bin";
const PICKS_S = "osmos-evo-1017/3c6b0aeb256c/picks/UD-IQ1_S/osmos-picks.bin";
const DRAFTER = "osmos-evo-1017/3c6b0aeb256c/dspark-iq2xs";

const HEADER_PINS = [
  "greedy",
  "400",
  "temperature",
  "934b51b9",
  "3c6b0aeb256c",
  "2688c0c3",
  "dspark",
  "derived",
  "not measured",
  "upgrade",
  "z13 agent",
] as const;

interface ArmResources {
  residentGiB: number;
  diskBackedGiB: number;
}

interface ArmSpec {
  file: string;
  name: string;
  port: number;
  rel: string;
  picks: string;
  resources: ArmResources;
  baselineFile: string;
  catalogRowId?: string;
  extraArgs: string[];
  headerPins: readonly string[];
}

const ARMS: readonly ArmSpec[] = [
  {
    file: "libosmos-ds41-ud-iq1m-z13.yaml",
    name: "libosmos-ds41-ud-iq1m",
    port: 8085,
    rel: IQ1M_REL,
    picks: PICKS_M,
    resources: { residentGiB: 100, diskBackedGiB: 133.2 },
    baselineFile: "llamacpp-ds41-ud-iq1m-hip-b12206-z13.yaml",
    extraArgs: [
      "--picks",
      PICKS_M,
      "--dspark",
      DRAFTER,
      "--budget",
      "100",
      "--max-context",
      "65536",
      "--parallel",
      "1",
      "--no-guess",
    ],
    headerPins: HEADER_PINS,
  },
  {
    file: "libosmos-ds41-ud-iq1s-z13.yaml",
    name: "libosmos-ds41-ud-iq1s",
    port: 8092,
    rel: IQ1S_REL,
    picks: PICKS_S,
    resources: { residentGiB: 100, diskBackedGiB: 117 },
    baselineFile: "llamacpp-deepseek41-flash-iq1s-z13.yaml",
    catalogRowId: "deepseek41-flash-1017-ud-iq1s",
    extraArgs: [
      "--picks",
      PICKS_S,
      "--dspark",
      DRAFTER,
      "--budget",
      "100",
      "--max-context",
      "65536",
      "--parallel",
      "1",
      "--no-guess",
    ],
    headerPins: HEADER_PINS,
  },
];

const tmpDirs: string[] = [];

function mkTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const arm of ARMS) {
  describe(arm.file, () => {
    test("parses strictly as a ModelHost manifest", () => {
      const { raw, manifest } = loadModelHostTemplate(arm.file);
      expect(manifest.apiVersion).toBe("llamactl/v1");
      expect(manifest.kind).toBe("ModelHost");
      const record = asRecord(raw);
      expect(record?.["kind"]).toBe("ModelHost");
    });

    test("is committed disabled via an explicit enabled: false", () => {
      const { raw, manifest } = loadModelHostTemplate(arm.file);
      expect(manifest.spec.enabled).toBe(false);
      const spec = asRecord(asRecord(raw)?.["spec"]);
      expect(spec?.["enabled"]).toBe(false);
    });

    test(`is named ${arm.name} with the pinned labels`, () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      expect(manifest.metadata.name).toBe(arm.name);
      const labels = manifest.metadata.labels;
      expect(labels?.["family"]).toBe("deepseek41");
      expect(labels?.["llamactl.io/qualification"]).toBe("experimental");
      expect(labels?.["llamactl.io/residency-group"]).toBe("z13-large-gpu");
      expect(labels?.["llamactl.io/runtime-arm"]).toBe(RUNTIME_ARM);
      expect(labels?.["llamactl.io/backend"]).toBe("hip");
    });

    test("pins the z13 libosmos identity, endpoint and memory", () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      const spec = manifest.spec;
      expect(spec.node).toBe("z13");
      expect(spec.engine).toBe("libosmos");
      expect(spec.restartPolicy).toBe("Never");
      expect(spec.endpoint).toEqual({ host: "127.0.0.1", port: arm.port });
      expect(spec.binary).toBe(RT);
      expect(isAbsolute(spec.binary)).toBe(true);
      expect(basename(spec.binary)).toBe("osmos-api");
      expect(spec.binaryNames).toBeUndefined();
      expect(spec.env).toBeUndefined();
      expect(spec.resources).toEqual(arm.resources);
      expect(spec.resources?.expectedMemoryGiB).toBeUndefined();
    });

    test("probes readiness via the osmos-api /health endpoint", () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      expect(manifest.spec.readiness).toEqual({
        path: "/health",
        expectStatus: 200,
        expectJson: { status: "ok" },
      });
    });

    test("hosts exactly the pinned rel with the osmos extraArgs", () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      const hosted = manifest.spec.hostedModels;
      expect(hosted).toHaveLength(1);
      const entry = hosted[0];
      expect(entry?.rel).toBe(arm.rel);
      expect(entry?.lora_path).toBeUndefined();
      expect(entry?.dflash).toBeUndefined();
      const args = manifest.spec.extraArgs;
      expect(args).toStrictEqual(arm.extraArgs);
      for (const flag of ["--config", "--host", "--port", "--engine", "-m", "--temperature"]) {
        expect(args).not.toContain(flag);
      }
    });

    test("builds the osmos-api boot argv under the workload runtime dir", () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      const rt = mkTmpDir("llamactl-libosmos-rt-");
      const boot = ENGINES.libosmos.buildBootCommand(specForEngine(manifest.spec), {
        LLAMACTL_RUNTIME_DIR: rt,
        workloadName: arm.name,
      });
      expect(boot.binary).toBe(RT);
      expect(boot.args).toStrictEqual([
        "--config",
        join(rt, "workloads", arm.name, ".osmos", "osmos.json"),
        "--host",
        "127.0.0.1",
        "--port",
        String(arm.port),
      ]);
    });

    test("generates the pinned osmos.json at prepareLaunch", async () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      const models = mkTmpDir("llamactl-libosmos-models-");
      const rt = mkTmpDir("llamactl-libosmos-rt-");
      const stub = join(mkTmpDir("llamactl-libosmos-bin-"), "osmos-api");
      writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      mkdirSync(dirname(join(models, arm.rel)), { recursive: true });
      writeFileSync(join(models, arm.rel), "");
      const spec = { ...specForEngine(manifest.spec), binary: stub };
      expect(ENGINES.libosmos.validateSpec(spec)).toEqual({ ok: true });
      await ENGINES.libosmos.prepareLaunch!(spec, {
        LLAMACTL_MODELS_DIR: models,
        LLAMACTL_RUNTIME_DIR: rt,
        workloadName: arm.name,
      });
      const configPath = join(rt, "workloads", arm.name, ".osmos", "osmos.json");
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toStrictEqual({
        pack: basename(arm.rel, ".gguf"),
        model: resolve(models, arm.rel),
        picks: resolve(models, arm.picks),
        drafter: resolve(models, DRAFTER),
        drafted_budget_gib: 100,
        max_context: 65536,
        parallel: 1,
        no_guess: true,
      });
    });

    test("claims its name, z13 port and rel uniquely and avoids reserved ports", () => {
      const { manifest } = loadModelHostTemplate(arm.file);
      expect(fileClaimingName(arm.name)).toEqual([arm.file]);
      expect(filesClaimingNodePort("z13", arm.port)).toEqual([arm.file]);
      expect(modelRunsTargetingRel(arm.rel)).toEqual([]);
      expect(RESERVED_PORTS).not.toContain(manifest.spec.endpoint.port);
    });

    test("forms a disabled arm pair with its llamacpp baseline on the shared rel", () => {
      loadModelHostTemplate(arm.file);
      const entries = carriers((doc) => hostedModelRels(doc).includes(arm.rel));
      const files = entries.map((entry) => entry.file);
      expect(files).toContain(arm.file);
      expect(files).toContain(arm.baselineFile);
      expectArmGroup(entries, 2);
    });

    test("pins provenance in the leading header comment", () => {
      const { header } = loadModelHostTemplate(arm.file);
      for (const pin of arm.headerPins) {
        expect(header).toContain(pin);
      }
    });

    const catalogRowId = arm.catalogRowId;
    if (catalogRowId !== undefined) {
      test("joins the pinned catalog row rel, engines, residency group and family", () => {
        const { raw, manifest } = loadModelHostTemplate(arm.file);
        const row = catalog.BUILTIN_CATALOG.find((m) => m.id === catalogRowId);
        expect(row).toBeDefined();
        if (row === undefined) return;
        expect(row.rel).toBe(arm.rel);
        expect(row.runtime?.engines).toEqual(
          arm.catalogRowId === "deepseek41-flash-1017-ud-iq1m"
            ? ["llamacpp"]
            : ["llamacpp", "libosmos"],
        );
        const doc = asRecord(raw);
        expect(doc).not.toBeNull();
        if (doc === null) return;
        expect(row.residencyGroup).toBe(residencyGroupLabel(doc) ?? undefined);
        expect(manifest.metadata.labels?.["family"]).toBe(row.family);
      });
    }
  });
}

test("keeps every z13-large-gpu ModelHost disabled", () => {
  for (const arm of ARMS) {
    loadModelHostTemplate(arm.file);
  }
  const group = templateDocs().filter(
    ({ doc }) => doc["kind"] === "ModelHost" && residencyGroupLabel(doc) === "z13-large-gpu",
  );
  expect(group.length).toBeGreaterThan(0);
  const offenders = group
    .filter(({ doc }) => asRecord(doc["spec"])?.["enabled"] !== false)
    .map(({ file }) => file);
  expect(offenders).toEqual([]);
});
