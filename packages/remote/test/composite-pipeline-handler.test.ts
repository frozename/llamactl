import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";

import {
  applyPipelineComponent,
  removePipelineComponent,
} from "../src/composite/handlers/pipeline.js";
import { PipelineCompositeEntrySchema } from "../src/composite/schema.js";
import { entrySpecHash } from "../src/workload/gateway-catalog/hash.js";

const entry = PipelineCompositeEntrySchema.parse({
  name: "docs",
  spec: {
    destination: { ragNode: "kb", collection: "d" },
    sources: [{ kind: "filesystem", root: "/x" }],
  },
});

type ApplyCtx = Parameters<typeof applyPipelineComponent>[1];
type ApplyCaller = ApplyCtx["caller"];
type ApplyInput = Parameters<ApplyCaller["ragPipelineApply"]>[0];
type RunInput = Parameters<ApplyCaller["ragPipelineRun"]>[0];
type ApplyResult = Awaited<ReturnType<ApplyCaller["ragPipelineApply"]>>;
type RemoveCaller = Parameters<typeof removePipelineComponent>[1]["caller"];
type RemoveInput = Parameters<RemoveCaller["ragPipelineRemove"]>[0];
type RemoveResult = Awaited<ReturnType<RemoveCaller["ragPipelineRemove"]>>;

interface ApplyFake {
  caller: ApplyCaller;
  applyInputs: ApplyInput[];
  runInputs: RunInput[];
}

interface RemoveFake {
  caller: RemoveCaller;
  inputs: RemoveInput[];
}

function makeApplyFake(applyResult: ApplyResult, run?: () => Promise<unknown>): ApplyFake {
  const applyInputs: ApplyInput[] = [];
  const runInputs: RunInput[] = [];
  return {
    applyInputs,
    runInputs,
    caller: {
      ragPipelineApply: (input: ApplyInput): Promise<ApplyResult> => {
        applyInputs.push(input);
        return Promise.resolve(applyResult);
      },
      ragPipelineRun: (input: RunInput): Promise<unknown> => {
        runInputs.push(input);
        return run === undefined ? Promise.resolve({ ok: true }) : run();
      },
    },
  };
}

function makeRemoveFake(result: RemoveResult): RemoveFake {
  const inputs: RemoveInput[] = [];
  return {
    inputs,
    caller: {
      ragPipelineRemove: (input: RemoveInput): Promise<RemoveResult> => {
        inputs.push(input);
        return Promise.resolve(result);
      },
    },
  };
}

function applyCtx(fake: ApplyFake): ApplyCtx {
  return { compositeName: "mc", caller: fake.caller };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
}

describe("applyPipelineComponent", () => {
  test("created pipeline records composite ownership and fires the first run", async () => {
    const fake = makeApplyFake({ ok: true, name: "docs", path: "/p", created: true });

    const result = await applyPipelineComponent(entry, applyCtx(fake));

    const applyInput = fake.applyInputs[0];
    if (!applyInput) {
      throw new Error("expected ragPipelineApply to have been called");
    }
    expect(fake.applyInputs).toHaveLength(1);
    expect(applyInput.ownership).toEqual({
      source: "composite",
      compositeNames: ["mc"],
      specHash: entrySpecHash(entry.spec),
    });
    expect(applyInput.ownership?.specHash).toMatch(/^[0-9a-f]{16}$/);
    expect(parseYaml(applyInput.manifestYaml)).toEqual({
      apiVersion: "llamactl/v1",
      kind: "RagPipeline",
      metadata: { name: "docs" },
      spec: entry.spec,
    });
    expect(result).toEqual({
      changed: true,
      status: { ref: { kind: "pipeline", name: "docs" }, state: "Ready" },
    });
    expect(fake.runInputs).toStrictEqual([{ name: "docs" }]);
  });

  test("an unchanged pipeline reports Ready without a first run", async () => {
    const fake = makeApplyFake({ ok: true, name: "docs", path: "/p", created: false });

    const result = await applyPipelineComponent(entry, applyCtx(fake));

    await flush();

    expect(result).toEqual({
      changed: false,
      status: { ref: { kind: "pipeline", name: "docs" }, state: "Ready" },
    });
    expect(fake.runInputs).toHaveLength(0);
  });

  test("a rejecting first run surfaces via onFirstRunError without failing apply", async () => {
    const runError = new Error("run failed");
    const firstRunErrors: [Error, string][] = [];
    const fake = makeApplyFake({ ok: true, name: "docs", path: "/p", created: true }, () =>
      Promise.reject(runError),
    );

    const result = await applyPipelineComponent(entry, {
      compositeName: "mc",
      caller: fake.caller,
      onFirstRunError: (err, name) => {
        firstRunErrors.push([err, name]);
      },
    });

    expect(result).toEqual({
      changed: true,
      status: { ref: { kind: "pipeline", name: "docs" }, state: "Ready" },
    });
    await flush();
    expect(firstRunErrors).toHaveLength(1);
    expect(firstRunErrors[0]?.[0]).toBe(runError);
    expect(firstRunErrors[0]?.[1]).toBe("docs");
  });

  test("a rejecting first run is swallowed when onFirstRunError is omitted", async () => {
    const fake = makeApplyFake({ ok: true, name: "docs", path: "/p", created: true }, () =>
      Promise.reject(new Error("run failed")),
    );

    const result = await applyPipelineComponent(entry, applyCtx(fake));

    await flush();

    expect(result).toEqual({
      changed: true,
      status: { ref: { kind: "pipeline", name: "docs" }, state: "Ready" },
    });
    expect(fake.runInputs).toHaveLength(1);
  });

  test("an operator-owned name conflict maps to PipelineNameCollision", async () => {
    const fake = makeApplyFake({
      ok: false,
      name: "docs",
      conflict: { kind: "name", name: "docs", existingOwner: "operator" },
    });

    const result = await applyPipelineComponent(entry, applyCtx(fake));

    expect(result).toEqual({
      changed: false,
      status: {
        ref: { kind: "pipeline", name: "docs" },
        state: "Pending",
        message: "PipelineNameCollision: pipeline 'docs' already exists as operator-managed",
      },
    });
    expect(fake.runInputs).toHaveLength(0);
  });

  test("a composite-owned name conflict names the composite owner", async () => {
    const fake = makeApplyFake({
      ok: false,
      name: "docs",
      conflict: { kind: "name", name: "docs", existingOwner: "composite" },
    });

    const result = await applyPipelineComponent(entry, applyCtx(fake));

    expect(result).toEqual({
      changed: false,
      status: {
        ref: { kind: "pipeline", name: "docs" },
        state: "Pending",
        message: "PipelineNameCollision: pipeline 'docs' already exists as composite-managed",
      },
    });
    expect(fake.runInputs).toHaveLength(0);
  });

  test("a shape conflict maps to PipelineShapeMismatch with the reason", async () => {
    const fake = makeApplyFake({
      ok: false,
      name: "docs",
      conflict: { kind: "shape", name: "docs", reason: "sources differ" },
    });

    const result = await applyPipelineComponent(entry, applyCtx(fake));

    expect(result).toEqual({
      changed: false,
      status: {
        ref: { kind: "pipeline", name: "docs" },
        state: "Pending",
        message:
          "PipelineShapeMismatch: pipeline 'docs' shape disagrees with prior composite (sources differ)",
      },
    });
    expect(fake.runInputs).toHaveLength(0);
  });
});

describe("removePipelineComponent", () => {
  test("forwards the composite-scoped removal", async () => {
    const fake = makeRemoveFake({ ok: true, deleted: true });

    const result = await removePipelineComponent(entry, {
      compositeName: "mc",
      caller: fake.caller,
    });

    expect(fake.inputs).toStrictEqual([{ name: "docs", compositeName: "mc" }]);
    expect(result).toEqual({ deleted: true });
  });

  test("a ref-counted non-delete maps to deleted false", async () => {
    const fake = makeRemoveFake({ ok: true, deleted: false });

    const result = await removePipelineComponent(entry, {
      compositeName: "mc",
      caller: fake.caller,
    });

    expect(fake.inputs).toStrictEqual([{ name: "docs", compositeName: "mc" }]);
    expect(result).toEqual({ deleted: false });
  });

  test("an operator-owned name conflict maps to deleted false", async () => {
    const fake = makeRemoveFake({
      ok: false,
      name: "docs",
      conflict: { kind: "name", name: "docs", existingOwner: "operator" },
    });

    const result = await removePipelineComponent(entry, {
      compositeName: "mc",
      caller: fake.caller,
    });

    expect(fake.inputs).toStrictEqual([{ name: "docs", compositeName: "mc" }]);
    expect(result).toEqual({ deleted: false });
  });
});
