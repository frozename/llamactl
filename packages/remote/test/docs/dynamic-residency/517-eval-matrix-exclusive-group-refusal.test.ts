import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #517
// Kills: the doc sentences missing or reworded, the gate absent or placed
// after spawn, either runner boot dropping it, and main not wiring it.
describe("#517 eval matrix exclusive-group refusal", () => {
  test("doc and source pin the pre-spawn eval matrix exclusive-group refusal", () => {
    const section = flat(sectionBody(sectionRe("direct modelhost start and stop")) ?? "");
    expect(section).toContain(
      "The eval matrix runner (`packages/eval/src/matrix/cli.ts`) boots managed model and judge engines in the CLI process and records no `residency_states` row, but every managed boot reads the local residency store read-only through `matrixLaunchRefusal` (`packages/eval/src/matrix/launch-gate.ts`) before spawning and records the cell as an error without spawning when the launch's declared-exclusive residency group is occupied (#517).",
    );
    expect(section).toContain(
      "`matrixLaunchRefusal` resolves a `gguf_path` under `LLAMA_CPP_MODELS` to the catalog rel beneath that root, falling back to `ModelSpec.name` when the path is outside the root, and takes the group from that rel's catalog row before delegating to `exclusiveGroupLaunchRefusal` (`packages/remote/src/residency/direct-lifecycle.ts`); an uncatalogued model, a model with no group, an undeclared or non-exclusive group, and a node with no store file launch as before.",
    );
    expect(section).toContain(
      "`ensureModelServing` consults the gate only after its `/health` probe misses and before `spawn`, so an engine already serving at the model's host and port is adopted without consulting the store, while a refused boot throws `eval matrix: residency lifecycle refused <rel> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>`.",
    );
    expect(section).toContain(
      "`runMatrix` threads its `launchRefusal` callback into both the model boot in `runModelCells` and the judge boot in `runWorkloadCell`, and the matrix CLI wires `matrixLaunchRefusal`, so a refused model or judge writes the workload's error cell and logs `[matrix] failed to boot ...` or `[matrix] failed to boot judge for ...` without spawning the engine binary.",
    );

    const lifecycleBody = enclosingBody(
      readOrEmpty(join(REPO, "packages/eval/src/matrix/lifecycle.ts")),
      "export async function ensureModelServing(",
    );
    expect(lifecycleBody, "ensureModelServing body").not.toBe("");
    const gateAt = lifecycleBody.indexOf("launchRefusal");
    expect(gateAt, "ensureModelServing consults launchRefusal").toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(lifecycleBody.indexOf("spawn("));
    expect(gateAt).toBeGreaterThan(lifecycleBody.indexOf("pingHealth("));

    const runnerSrc = readOrEmpty(join(REPO, "packages/eval/src/matrix/runner.ts"));
    const modelCellsBody = enclosingBody(runnerSrc, "async function runModelCells(");
    expect(modelCellsBody, "runModelCells body").not.toBe("");
    expect(modelCellsBody).toContain("launchRefusal");
    const workloadCellBody = enclosingBody(runnerSrc, "async function runWorkloadCell(");
    expect(workloadCellBody, "runWorkloadCell body").not.toBe("");
    expect(workloadCellBody).toContain("launchRefusal");

    const cliBody = enclosingBody(
      readOrEmpty(join(REPO, "packages/eval/src/matrix/cli.ts")),
      "async function main(",
    );
    expect(cliBody, "matrix cli main body").not.toBe("");
    expect(cliBody).toContain("launchRefusal: matrixLaunchRefusal");
  });
});
