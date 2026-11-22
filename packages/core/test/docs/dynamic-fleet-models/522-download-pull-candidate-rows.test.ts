import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { maybeTuneAfterPull } from "../../../src/autotune.js";
import { relFromRepoAndFile } from "../../../src/catalog.js";
import { eligibleGgufSiblings } from "../../../src/discovery.js";
import { resolveEnv } from "../../../src/env.js";
import {
  pickCandidateFile,
  pullRepo,
  pullRepoFile,
  resolveHfBin,
  type RunHf,
} from "../../../src/pull.js";
import { existsSync, mkdtempSync, rmSync } from "../../../src/safe-fs.js";
import {
  doc,
  enclosingBody,
  exclusiveRows,
  flat,
  readOrEmpty,
  REPO,
  sectionBody,
} from "./helpers.js";

// Part of #522: download/checksum/rollback slice
//
// Pins the `### What `llamactl pull` does with a candidate row` subsection
// of docs/dynamic-fleet-models.md and the pull/autotune/discovery behaviour
// it describes: the hf argv and default target, first-shard-only rels, the
// relFromRepoAndFile layout gap, the slash file argument, the auto-tune
// gate, the local-only bulk pull, the candidate auto-pick short-circuit,
// the hf binary/token resolution and the absence of checksum code. The
// subsection does not exist on the base, so every case fails by assertion
// on the missing section; the source and behaviour halves already pass.
const S = sectionBody(/^### What `llamactl pull` does with a candidate row/);

function section(): string {
  expect(S, "missing subsection").toBeDefined();
  return flat(S!);
}

const pullSrc = readOrEmpty(join(REPO, "packages/core/src/pull.ts"));
const cliPullSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/pull.ts"));
const discoverySrc = readOrEmpty(join(REPO, "packages/core/src/discovery.ts"));

const tmp = mkdtempSync(join(tmpdir(), "llamactl-522-pull-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const resolved = {
  ...resolveEnv({ ...process.env, LLAMA_CPP_MODELS: tmp }),
  LLAMA_CPP_MODELS: tmp,
};

function recordingRunHf(calls: string[][]): RunHf {
  return (args) => {
    calls.push([...args]);
    return Promise.resolve(0);
  };
}

describe("#522 download/checksum/rollback candidate rows", () => {
  // Kills: moving the subsection ahead of the Rollback paragraph or out of
  // the Download, checksum and rollback section, or dropping pin/freeze/
  // catalogQualificationStages from the parent body.
  test("T1: subsection placement inside Download, checksum and rollback", () => {
    const heading = "### What `llamactl pull` does with a candidate row";
    const at = doc.indexOf(heading);
    expect(at, "subsection heading present").toBeGreaterThanOrEqual(0);
    expect(at, "after ## Download, checksum and rollback").toBeGreaterThan(
      doc.indexOf("## Download, checksum and rollback"),
    );
    const rollbackAt = doc.indexOf("Rollback:");
    expect(rollbackAt, "Rollback paragraph present").toBeGreaterThanOrEqual(0);
    expect(at, "after the Rollback paragraph").toBeGreaterThan(rollbackAt);
    expect(at, "before ## GLM-5.3-Flash z13 eval record").toBeLessThan(
      doc.indexOf("## GLM-5.3-Flash z13 eval record"),
    );
    const parent = flat(sectionBody(/^## Download, checksum and rollback/) ?? "");
    for (const needle of ["pin", "freeze", "catalogQualificationStages"]) {
      expect(parent, needle).toContain(needle);
    }
  });

  // Kills: adding --revision to the hf argv or changing the default target
  // dir; the doc must state both.
  test("T2: pull file argv is hf download <repo> <file> --local-dir <models>/<repo-basename>", async () => {
    const repo = "j2ipper/GLM-5.3-Flash-a4e3s";
    const file = "GLM-5.3-Flash-a4e3s-00001-of-00004.gguf";
    const calls: string[][] = [];
    const result = await pullRepoFile({
      repo,
      file,
      skipMmproj: true,
      resolved,
      runHf: recordingRunHf(calls),
    });
    expect(calls).toEqual([
      ["download", repo, file, "--local-dir", join(tmp, "GLM-5.3-Flash-a4e3s")],
    ]);
    for (const argv of calls) {
      for (const arg of argv) {
        expect(arg.includes("revision"), `no revision flag in '${arg}'`).toBe(false);
      }
    }
    expect(result.target).toBe(join(tmp, "GLM-5.3-Flash-a4e3s"));
    expect(result.rel).toBe("GLM-5.3-Flash-a4e3s/GLM-5.3-Flash-a4e3s-00001-of-00004.gguf");
    const s = section();
    expect(s).toContain(
      "`llamactl pull file` and `llamactl pull candidate` run `hf download <repo> <file> --local-dir <target>` with `<target>` defaulting to `$LLAMA_CPP_MODELS/<repo-basename>` (`pullRepoFile`, `packages/core/src/pull.ts`), and the argv never carries `--revision`, so the fetch tracks the repo's current default head rather than the catalog row's pinned revision.",
    );
  });

  // Kills: a doc claiming all shards are fetched, or a catalog rel change
  // away from the -00001-of-NNNNN.gguf first-shard layout without a doc
  // update.
  test("T3: every .gguf exclusive rel names only the first shard", () => {
    const ggufRows = exclusiveRows.filter((row) => row.rel.endsWith(".gguf"));
    expect(ggufRows.length).toBeGreaterThan(0);
    for (const row of ggufRows) {
      expect(row.rel, row.id).toMatch(/-00001-of-\d{5}\.gguf$/i);
    }
    const s = section();
    expect(s).toContain(
      "Every `.gguf` rel in the candidate set names only the first shard of its multi-part file — `...-00001-of-NNNNN.gguf` — and `llamactl pull` fetches exactly the file it is given, so pulling a candidate rel lands shard 1 alone; the remaining shards are not fetched.",
    );
  });

  // Kills: relFromRepoAndFile silently learning the pinned
  // <repo>-<owner>/<rev8> layout, or a doc update that stops saying the
  // pull cannot reproduce those rels.
  test("T4: relFromRepoAndFile cannot reproduce the pinned candidate rels", () => {
    for (const id of [
      "glm53-flash-a4e3s",
      "deepseek41-flash-1017-ud-iq1s",
      "deepseek41-flash-1017-ud-iq1m",
      "mimo26-flash-mopd-bpw25",
    ]) {
      const row = exclusiveRows.find((r) => r.id === id);
      expect(row, `catalog row ${id}`).toBeDefined();
      expect(
        relFromRepoAndFile(row!.repo, basename(row!.rel)),
        `${id} rel is not reproducible from repo + basename`,
      ).not.toBe(row!.rel);
    }
    const s = section();
    expect(s).toContain(
      "`relFromRepoAndFile` (`packages/core/src/catalog.ts`) does not learn the `<repo>-<owner>/<rev8>/...` models-root layout, so `llamactl pull` cannot reproduce the catalog rel of `glm53-flash-a4e3s`, `deepseek41-flash-1017-ud-iq1s`, `deepseek41-flash-1017-ud-iq1m` or `mimo26-flash-mopd-bpw25` from a plain file argument.",
    );
  });

  // Kills: dropping the includes('/') branch in relFromRepoAndFile, or a
  // doc that stops documenting the slash file argument pass-through.
  test("T5: a slash file argument is kept as the rel verbatim", async () => {
    const repo = "unsloth/DeepSeek-V4.1-Flash-1017-GGUF";
    const file = "UD-IQ1_S/X-00001-of-00005.gguf";
    const calls: string[][] = [];
    const result = await pullRepoFile({
      repo,
      file,
      skipMmproj: true,
      resolved,
      runHf: recordingRunHf(calls),
    });
    expect(result.rel).toBe(file);
    expect(result.target).toBe(join(tmp, "DeepSeek-V4.1-Flash-1017-GGUF"));
    expect(calls).toEqual([
      ["download", repo, file, "--local-dir", join(tmp, "DeepSeek-V4.1-Flash-1017-GGUF")],
    ]);
    const s = section();
    expect(s).toContain(
      "A file argument that already contains `/` is kept as the rel verbatim — `UD-IQ1_S/X-00001-of-00005.gguf` stays `UD-IQ1_S/X-00001-of-00005.gguf` — while the download still targets `$LLAMA_CPP_MODELS/<repo-basename>` (`pullRepoFile`, `packages/core/src/pull.ts`).",
    );
  });

  // Kills: inverting the wasMissing gate, changing either skip message, or
  // documenting a tune that runs on re-pull or with the env flag off.
  test("T6: auto-tune runs only for a missing file with the env flag on", async () => {
    const notMissing = await maybeTuneAfterPull({
      rel: "x/y.gguf",
      wasMissing: false,
      resolved,
      env: {},
    });
    expect(notMissing.preset).toEqual({
      ran: false,
      reason: { kind: "not-missing", message: "Model was already on disk" },
    });
    const disabled = await maybeTuneAfterPull({
      rel: "x/y.gguf",
      wasMissing: true,
      resolved,
      env: { LLAMA_CPP_AUTO_TUNE_ON_PULL: "off" },
    });
    expect(disabled.preset).toEqual({
      ran: false,
      reason: { kind: "auto-tune-disabled", message: "LLAMA_CPP_AUTO_TUNE_ON_PULL=off" },
    });
    const s = section();
    expect(s).toContain(
      "`maybeTuneAfterPull` (`packages/core/src/autotune.ts`) runs the post-pull bench only when the file was absent before the pull — a re-pull skips with `Model was already on disk` — and only while `LLAMA_CPP_AUTO_TUNE_ON_PULL` is enabled, otherwise it skips with `LLAMA_CPP_AUTO_TUNE_ON_PULL=off`; `--no-tune` skips the call entirely (`packages/cli/src/commands/pull.ts`).",
    );
  });

  // Kills: adding node dispatch or an auto-tune step to the bulk pull path,
  // or a doc that stops saying the bulk form is local-only and untuned.
  test("T7: bulk pull argv is repo-wide and the CLI path stays local", async () => {
    const repo = "unsloth/DeepSeek-V4.1-Flash-1017-GGUF";
    const calls: string[][] = [];
    const result = await pullRepo({ repo, resolved, runHf: recordingRunHf(calls) });
    expect(calls).toEqual([["download", repo, "--local-dir", join(tmp, basename(repo))]]);
    expect(result.target).toBe(join(tmp, basename(repo)));
    expect(cliPullSrc).toContain("(No auto-tune.)");
    const body = enclosingBody(cliPullSrc, "async function runPullRepo(");
    expect(body, "runPullRepo signature").not.toBe("");
    expect(body).not.toContain("getNodeClient");
    expect(body).not.toContain("isLocalDispatch");
    const s = section();
    expect(s).toContain(
      "The bulk form `llamactl pull <hf-repo> [target-dir]` runs `hf download <repo> --local-dir <target>` through `pullRepo` (`packages/core/src/pull.ts`) with no auto-tune — the usage string says `(No auto-tune.)` — and `runPullRepo` (`packages/cli/src/commands/pull.ts`) invokes it in-process with no node-client dispatch, so the bulk pull never fans out to `--node`.",
    );
  });

  // Kills: removing the shard regex at discovery.ts or breaking the
  // requested-file short-circuit in pickCandidateFile, or a doc that stops
  // naming the auto-pick-only behaviour and the explicit-file pass-through.
  test("T8: candidate auto-pick drops shards; an explicit file passes through", async () => {
    type HFModelInfoParam = Parameters<typeof eligibleGgufSiblings>[0];
    const info = {
      id: "o/r",
      siblings: [{ rfilename: "A-00001-of-00004.gguf" }, { rfilename: "B-Q4_K_M.gguf" }],
    } as HFModelInfoParam;
    expect(eligibleGgufSiblings(info)).toEqual(["B-Q4_K_M.gguf"]);
    expect(discoverySrc).toContain("-\\d{5}-of-\\d{5}");
    const pick = await pickCandidateFile({
      repo: "o/r",
      file: "A-00001-of-00004.gguf",
      resolved,
      profile: resolved.LLAMA_CPP_MACHINE_PROFILE,
    });
    expect(pick).not.toBeNull();
    expect(pick?.source).toBe("requested");
    expect(pick?.file).toBe("A-00001-of-00004.gguf");
    expect(pick?.eligible).toEqual(["A-00001-of-00004.gguf"]);
    const s = section();
    expect(s).toContain(
      '`llamactl pull candidate <hf-repo> [gguf-file] [profile]` auto-picks only when no file is given: it reads HF model-info, keeps the `eligibleGgufSiblings` set (`packages/core/src/discovery.ts`) — which drops mmproj sidecars, bf16/fp16/f16 directories and every `-NNNNN-of-NNNNN.gguf` shard — and walks the profile\'s quant ladder, while an explicit file argument short-circuits the HF lookup and is pulled verbatim with `source: "requested"` (`pickCandidateFile`, `packages/core/src/pull.ts`).',
    );
  });

  // Kills: adding checksum verification to pull.ts, a doc claiming
  // automatic verification, a dangling packages//docs citation, a
  // file:line citation, or dropping one of the five cited sources.
  test("T9: pull verifies no checksum; citations resolve; parent keeps sha256", () => {
    expect(pullSrc.includes("sha256")).toBe(false);
    expect(pullSrc.includes("createHash")).toBe(false);
    const parent = flat(sectionBody(/^## Download, checksum and rollback/) ?? "");
    expect(parent).toContain("sha256");
    const s = section();
    expect(/\.(?:ts|md):\d+/.test(s), "no file:line citation").toBe(false);
    const cited = new Set(
      [...s.matchAll(/`((?:packages|docs)\/[^`\s]+\.(?:ts|md))`/g)].flatMap((m) =>
        m[1] === undefined ? [] : [m[1]],
      ),
    );
    expect(cited.size).toBeGreaterThan(0);
    for (const p of cited) {
      expect(existsSync(join(REPO, p)), `cited path exists: ${p}`).toBe(true);
    }
    for (const required of [
      "packages/core/src/pull.ts",
      "packages/core/src/catalog.ts",
      "packages/core/src/autotune.ts",
      "packages/core/src/discovery.ts",
      "packages/cli/src/commands/pull.ts",
    ]) {
      expect(cited.has(required), `cites ${required}`).toBe(true);
    }
    expect(s).toContain(
      "`packages/core/src/pull.ts` carries no checksum code — no `sha256`, no `createHash` — so `llamactl pull` stores whatever `hf download` writes without verifying it, and per-shard sha256 verification against the HF LFS oid stays the manual step above.",
    );
  });

  // Kills: dropping the LOCAL_AI_HF_BIN override or changing the HF_HOME
  // token-file default without a doc update.
  test("T10: hf binary override and token sources", () => {
    expect(resolveHfBin({ LOCAL_AI_HF_BIN: "/x/hf", PATH: "" })).toBe("/x/hf");
    expect(resolveHfBin({ PATH: "" })).toBe("hf");
    expect(pullSrc).toContain("HUGGING_FACE_HUB_TOKEN");
    expect(pullSrc).toContain(".cache/huggingface");
    const s = section();
    expect(s).toContain(
      "The `hf` binary resolves through `resolveHfBin` (`packages/core/src/pull.ts`): `LOCAL_AI_HF_BIN` wins when set, then `hf` or `huggingface-cli` on `PATH`, then the literal `hf`; the token resolves from `HF_TOKEN`, then `HUGGING_FACE_HUB_TOKEN`, then `$HF_HOME/token` (default `~/.cache/huggingface/token`).",
    );
  });
});
