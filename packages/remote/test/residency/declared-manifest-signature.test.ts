/**
 * #280 DF-07 — declaredManifestSignature is the change signature the proxy
 * folds into its cached stale-binding projection. It must move on an
 * in-place manifest edit (which does not bump the dir mtime), on a new or
 * removed manifest, and on a lease phase change, and stay put otherwise.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  declaredManifestSignature,
  type DeclaredWorkloadPhase,
} from "../../src/residency/catalog.js";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "../../src/safe-fs.js";

let sandbox = "";

afterEach(() => {
  if (sandbox !== "") rmSync(sandbox, { recursive: true, force: true });
  sandbox = "";
});

function setup(): string {
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-declared-manifest-sig-"));
  return sandbox;
}

describe("declaredManifestSignature (#280 DF-07)", () => {
  test("is stable while nothing changes", () => {
    const dir = setup();
    writeFileSync(join(dir, "host-a.yaml"), "kind: ModelHost\n");
    expect(declaredManifestSignature({ dir })).toBe(declaredManifestSignature({ dir }));
  });

  test("moves on an in-place manifest edit", () => {
    // Kills: a signature built from the dir mtime alone.
    const dir = setup();
    const file = join(dir, "host-a.yaml");
    writeFileSync(file, "kind: ModelHost\n");
    utimesSync(file, 1_000, 1_000);
    utimesSync(dir, 1_000, 1_000);
    const before = declaredManifestSignature({ dir });
    writeFileSync(file, "kind: ModelHost\n# edited\n");
    utimesSync(file, 2_000, 2_000);
    utimesSync(dir, 1_000, 1_000);
    expect(declaredManifestSignature({ dir })).not.toBe(before);
  });

  test("moves when a manifest is added", () => {
    const dir = setup();
    writeFileSync(join(dir, "host-a.yaml"), "kind: ModelHost\n");
    utimesSync(dir, 1_000, 1_000);
    const before = declaredManifestSignature({ dir });
    writeFileSync(join(dir, "host-b.yaml"), "kind: ModelHost\n");
    utimesSync(dir, 1_000, 1_000);
    expect(declaredManifestSignature({ dir })).not.toBe(before);
  });

  test("moves on a lease phase change of a manifest's workload", () => {
    // Kills: dropping the workloadPhase hook (a draining lease suppresses a
    // stale reason, so the cached projection must be re-read).
    const dir = setup();
    writeFileSync(join(dir, "host-a.yaml"), "kind: ModelHost\n");
    let phase: DeclaredWorkloadPhase | undefined = "open";
    const workloadPhase = (workload: string): DeclaredWorkloadPhase | undefined =>
      workload === "host-a" ? phase : undefined;
    const before = declaredManifestSignature({ dir, workloadPhase });
    phase = "draining";
    expect(declaredManifestSignature({ dir, workloadPhase })).not.toBe(before);
  });

  test("a missing dir or throwing phase hook degrades instead of throwing", () => {
    const dir = setup();
    writeFileSync(join(dir, "host-a.yaml"), "kind: ModelHost\n");
    const throwing = (): DeclaredWorkloadPhase | undefined => {
      throw new Error("boom");
    };
    expect(() => declaredManifestSignature({ dir, workloadPhase: throwing })).not.toThrow();
    expect(() => declaredManifestSignature({ dir: join(dir, "missing") })).not.toThrow();
  });
});
