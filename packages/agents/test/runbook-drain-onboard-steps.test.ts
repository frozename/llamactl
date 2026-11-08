/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-empty-function, @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Test doubles implement async runbook interfaces and Bun's rejects matcher is typed as void. */
import { describe, expect, test } from "bun:test";

import { type RunbookToolClient, runRunbook, type ToolCallInput } from "../src/index.js";

interface Call {
  name: string;
  arguments: Record<string, unknown>;
}

function makeClient(handlers: Record<string, (args: Record<string, unknown>) => unknown>): {
  client: RunbookToolClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client: RunbookToolClient = {
    async callTool(input: ToolCallInput) {
      calls.push({ name: input.name, arguments: input.arguments });
      const handler = handlers[input.name];
      if (!handler) throw new Error(`unexpected tool call: ${input.name}`);
      return { content: [{ type: "text", text: JSON.stringify(handler(input.arguments)) }] };
    },
  };
  return { client, calls };
}

describe("drain-node step ledger and log", () => {
  test("wet-run records list totals from payload.count, one delete step per match in list order, then node.remove", async () => {
    const logs: string[] = [];
    const { client, calls } = makeClient({
      "llamactl.workload.list": () => ({
        count: 7,
        workloads: [
          { name: "a", node: "gpu1", rel: "x" },
          { name: "b", node: "gpu2", rel: "x" },
          { name: "c", node: "gpu1", rel: "x" },
        ],
      }),
      "llamactl.workload.delete": (args) => ({ deleted: args["name"] }),
      "llamactl.node.remove": (args) => ({ removed: args["name"] }),
    });

    const result = await runRunbook(
      "drain-node",
      { node: "gpu1" },
      { dryRun: false, log: (m) => logs.push(m), toolClient: client },
    );

    expect(calls).toStrictEqual([
      { name: "llamactl.workload.list", arguments: {} },
      { name: "llamactl.workload.delete", arguments: { name: "a", dryRun: false } },
      { name: "llamactl.workload.delete", arguments: { name: "c", dryRun: false } },
      { name: "llamactl.node.remove", arguments: { name: "gpu1", dryRun: false } },
    ]);

    expect(result).toStrictEqual({
      ok: true,
      steps: [
        { tool: "llamactl.workload.list", dryRun: false, result: { total: 7, matching: 2 } },
        { tool: "llamactl.workload.delete", dryRun: false, result: { deleted: "a" } },
        { tool: "llamactl.workload.delete", dryRun: false, result: { deleted: "c" } },
        { tool: "llamactl.node.remove", dryRun: false, result: { removed: "gpu1" } },
      ],
      summary: { node: "gpu1", drainedWorkloads: ["a", "c"], nodeRemoved: true },
    });

    expect(logs).toStrictEqual(["drain-node: removed 2 manifest(s) on gpu1 + node"]);
  });

  test("dry-run stamps dryRun:true on every mutation step but not on the list step", async () => {
    const { client, calls } = makeClient({
      "llamactl.workload.list": () => ({
        count: 7,
        workloads: [
          { name: "a", node: "gpu1", rel: "x" },
          { name: "b", node: "gpu2", rel: "x" },
          { name: "c", node: "gpu1", rel: "x" },
        ],
      }),
      "llamactl.workload.delete": (args) => ({ deleted: args["name"] }),
      "llamactl.node.remove": (args) => ({ removed: args["name"] }),
    });

    const result = await runRunbook(
      "drain-node",
      { node: "gpu1" },
      { dryRun: true, log: () => {}, toolClient: client },
    );

    expect(result.steps.map((s) => [s.tool, s.dryRun])).toStrictEqual([
      ["llamactl.workload.list", false],
      ["llamactl.workload.delete", true],
      ["llamactl.workload.delete", true],
      ["llamactl.node.remove", true],
    ]);

    const deleteCalls = calls.filter((c) => c.name === "llamactl.workload.delete");
    for (const d of deleteCalls) expect(d.arguments["dryRun"]).toBe(true);
    const nodeRemove = calls.find((c) => c.name === "llamactl.node.remove")!;
    expect(nodeRemove.arguments["dryRun"]).toBe(true);
  });

  test("keepNode:true logs the (node kept) suffix and omits the node.remove step", async () => {
    const logs: string[] = [];
    const { client, calls } = makeClient({
      "llamactl.workload.list": () => ({
        count: 1,
        workloads: [{ name: "w1", node: "keepme", rel: "x" }],
      }),
      "llamactl.workload.delete": () => ({ deleted: "w1" }),
    });

    const result = await runRunbook(
      "drain-node",
      { node: "keepme", keepNode: true },
      { dryRun: false, log: (m) => logs.push(m), toolClient: client },
    );

    expect(logs).toStrictEqual(["drain-node: removed 1 manifest(s) on keepme (node kept)"]);
    expect(result.steps.map((s) => s.tool)).toStrictEqual([
      "llamactl.workload.list",
      "llamactl.workload.delete",
    ]);
    expect(result).toStrictEqual({
      ok: true,
      steps: [
        { tool: "llamactl.workload.list", dryRun: false, result: { total: 1, matching: 1 } },
        { tool: "llamactl.workload.delete", dryRun: false, result: { deleted: "w1" } },
      ],
      summary: { node: "keepme", drainedWorkloads: ["w1"], nodeRemoved: false },
    });
  });

  test("matches the node name exactly", async () => {
    const logs: string[] = [];
    const { client, calls } = makeClient({
      "llamactl.workload.list": () => ({
        count: 3,
        workloads: [
          { name: "a", node: "gpu10", rel: "x" },
          { name: "b", node: "GPU1", rel: "x" },
          { name: "c", node: "gpu1-x", rel: "x" },
        ],
      }),
      "llamactl.node.remove": (args) => ({ removed: args["name"] }),
    });

    const result = await runRunbook(
      "drain-node",
      { node: "gpu1" },
      { dryRun: false, log: (m) => logs.push(m), toolClient: client },
    );

    expect(result.steps[0]!.result).toStrictEqual({ total: 3, matching: 0 });
    expect(calls.map((c) => c.name)).toStrictEqual([
      "llamactl.workload.list",
      "llamactl.node.remove",
    ]);
    expect(logs).toStrictEqual(["drain-node: removed 0 manifest(s) on gpu1 + node"]);
  });

  test("a delete that throws mid-loop stops the drain before node.remove", async () => {
    const logs: string[] = [];
    const { client, calls } = makeClient({
      "llamactl.workload.list": () => ({
        count: 2,
        workloads: [
          { name: "a", node: "gpu1", rel: "x" },
          { name: "b", node: "gpu1", rel: "x" },
        ],
      }),
      "llamactl.workload.delete": (args) => {
        if (args["name"] === "b") throw new Error("delete refused: b");
        return { deleted: args["name"] };
      },
      "llamactl.node.remove": (args) => ({ removed: args["name"] }),
    });

    const result = await runRunbook(
      "drain-node",
      { node: "gpu1" },
      { dryRun: false, log: (m) => logs.push(m), toolClient: client },
    );

    expect(result).toStrictEqual({
      ok: false,
      steps: [],
      error: "delete refused: b",
    });
    expect(calls.map((c) => c.name)).toStrictEqual([
      "llamactl.workload.list",
      "llamactl.workload.delete",
      "llamactl.workload.delete",
    ]);
    expect(logs).toStrictEqual([]);
  });

  test("rejects an empty node and a non-boolean keepNode before any tool call", async () => {
    const { client, calls } = makeClient({});

    await expect(
      runRunbook("drain-node", { node: "" }, { dryRun: false, log: () => {}, toolClient: client }),
    ).rejects.toThrow(/^runbook drain-node: invalid params — /);

    await expect(
      runRunbook(
        "drain-node",
        { node: "gpu1", keepNode: "yes" } as unknown as { node: string; keepNode: boolean },
        { dryRun: false, log: () => {}, toolClient: client },
      ),
    ).rejects.toThrow(/^runbook drain-node: invalid params — /);

    expect(calls).toStrictEqual([]);
  });
});

describe("onboard-new-gpu-node step ledger, fallbacks and log", () => {
  test("dry-run records only the preview step, forwards exact add args, and logs the dry-run line", async () => {
    const logs: string[] = [];
    const { client, calls } = makeClient({
      "llamactl.node.add": (args) => ({
        dryRun: true,
        message: "would add gpu1",
        node: { name: "gpu1" },
      }),
    });

    const result = await runRunbook(
      "onboard-new-gpu-node",
      { name: "gpu1", bootstrap: "blob" },
      { dryRun: true, log: (m) => logs.push(m), toolClient: client },
    );

    expect(calls).toStrictEqual([
      { name: "llamactl.node.add", arguments: { name: "gpu1", bootstrap: "blob", dryRun: true } },
    ]);

    expect(result).toStrictEqual({
      ok: true,
      steps: [
        {
          tool: "llamactl.node.add",
          dryRun: true,
          result: { dryRun: true, message: "would add gpu1", node: { name: "gpu1" } },
        },
      ],
      summary: {
        dryRun: true,
        name: "gpu1",
        preview: { dryRun: true, message: "would add gpu1", node: { name: "gpu1" } },
      },
    });

    expect(logs).toStrictEqual([
      "onboard-new-gpu-node: dry-run \u2014 would add gpu1 and sync embersynth",
    ]);
  });

  test("a preview error fails the run even in dry-run mode", async () => {
    const logs: string[] = [];
    const { client, calls } = makeClient({
      "llamactl.node.add": () => ({ dryRun: true, message: "x", error: "bad magic" }),
    });

    const result = await runRunbook(
      "onboard-new-gpu-node",
      { name: "gpu1", bootstrap: "blob" },
      { dryRun: true, log: (m) => logs.push(m), toolClient: client },
    );

    expect(result).toStrictEqual({
      ok: false,
      steps: [
        {
          tool: "llamactl.node.add",
          dryRun: true,
          result: { dryRun: true, message: "x", error: "bad magic" },
        },
      ],
      error: "bootstrap blob rejected: bad magic",
    });
    expect("summary" in result).toBe(false);
    expect(calls).toStrictEqual([
      { name: "llamactl.node.add", arguments: { name: "gpu1", bootstrap: "blob", dryRun: true } },
    ]);
    expect(logs).toStrictEqual([]);
  });

  test("a wet node.add ok:false forwards its error and stops before node.ls", async () => {
    const { client, calls } = makeClient({
      "llamactl.node.add": (args) =>
        args["dryRun"]
          ? { dryRun: true, message: "preview", node: { name: "gpu1" } }
          : { ok: false, error: "fingerprint mismatch" },
    });

    const result = await runRunbook(
      "onboard-new-gpu-node",
      { name: "gpu1", bootstrap: "blob" },
      { dryRun: false, log: () => {}, toolClient: client },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("fingerprint mismatch");
    expect(result.steps.map((s) => [s.tool, s.dryRun])).toStrictEqual([
      ["llamactl.node.add", true],
      ["llamactl.node.add", false],
    ]);
    expect(calls.map((c) => c.name)).toStrictEqual(["llamactl.node.add", "llamactl.node.add"]);
    expect("summary" in result).toBe(false);
  });

  test("a wet node.add ok:false without an error falls back to node.add failed", async () => {
    const { client, calls } = makeClient({
      "llamactl.node.add": (args) =>
        args["dryRun"]
          ? { dryRun: true, message: "preview", node: { name: "gpu1" } }
          : { ok: false },
    });

    const result = await runRunbook(
      "onboard-new-gpu-node",
      { name: "gpu1", bootstrap: "blob" },
      { dryRun: false, log: () => {}, toolClient: client },
    );

    expect(result.error).toBe("node.add failed");
    expect(result.ok).toBe(false);
    expect(calls.map((c) => c.name)).toStrictEqual(["llamactl.node.add", "llamactl.node.add"]);
  });

  test("wet success records the node.ls confirmation and sync result, and logs the cluster and node count", async () => {
    const logs: string[] = [];
    const { client, calls } = makeClient({
      "llamactl.node.add": (args) =>
        args["dryRun"]
          ? { dryRun: true, message: "preview", node: { name: "gpu1" } }
          : { ok: true, name: "gpu1", endpoint: "https://gpu1:7843" },
      "llamactl.node.ls": () => ({
        context: "default",
        cluster: "home",
        nodes: [
          { name: "local", kind: "agent" },
          { name: "gpu1", kind: "agent" },
        ],
      }),
      "llamactl.embersynth.sync": () => ({ ok: true, profiles: 5 }),
    });

    const result = await runRunbook(
      "onboard-new-gpu-node",
      { name: "gpu1", bootstrap: "blob" },
      { dryRun: false, log: (m) => logs.push(m), toolClient: client },
    );

    expect(result.steps).toStrictEqual([
      {
        tool: "llamactl.node.add",
        dryRun: true,
        result: { dryRun: true, message: "preview", node: { name: "gpu1" } },
      },
      {
        tool: "llamactl.node.add",
        dryRun: false,
        result: { ok: true, name: "gpu1", endpoint: "https://gpu1:7843" },
      },
      { tool: "llamactl.node.ls", dryRun: false, result: { confirmed: true, totalNodes: 2 } },
      { tool: "llamactl.embersynth.sync", dryRun: false, result: { ok: true, profiles: 5 } },
    ]);

    const lsCall = calls[2];
    expect(lsCall!.arguments).toStrictEqual({});
    const syncCall = calls[3];
    expect(syncCall!.arguments).toStrictEqual({ dryRun: false });

    expect(result).toStrictEqual({
      ok: true,
      steps: [
        {
          tool: "llamactl.node.add",
          dryRun: true,
          result: { dryRun: true, message: "preview", node: { name: "gpu1" } },
        },
        {
          tool: "llamactl.node.add",
          dryRun: false,
          result: { ok: true, name: "gpu1", endpoint: "https://gpu1:7843" },
        },
        { tool: "llamactl.node.ls", dryRun: false, result: { confirmed: true, totalNodes: 2 } },
        { tool: "llamactl.embersynth.sync", dryRun: false, result: { ok: true, profiles: 5 } },
      ],
      summary: { name: "gpu1", endpoint: "https://gpu1:7843", cluster: "home", totalNodes: 2 },
    });

    expect(logs).toStrictEqual(["onboard-new-gpu-node: gpu1 joined cluster home (2 total nodes)"]);
  });

  test("wet success with no endpoint and a null cluster reports endpoint null and logs cluster ?", async () => {
    const logs: string[] = [];
    const { client, calls } = makeClient({
      "llamactl.node.add": (args) =>
        args["dryRun"]
          ? { dryRun: true, message: "preview", node: { name: "gpu1" } }
          : { ok: true, name: "gpu1" },
      "llamactl.node.ls": () => ({
        context: null,
        cluster: null,
        nodes: [{ name: "gpu1", kind: "agent" }],
      }),
      "llamactl.embersynth.sync": () => ({ ok: true, profiles: 0 }),
    });

    const result = await runRunbook(
      "onboard-new-gpu-node",
      { name: "gpu1", bootstrap: "blob" },
      { dryRun: false, log: (m) => logs.push(m), toolClient: client },
    );

    expect(result.summary).toStrictEqual({
      name: "gpu1",
      endpoint: null,
      cluster: null,
      totalNodes: 1,
    });
    expect(logs).toStrictEqual(["onboard-new-gpu-node: gpu1 joined cluster ? (1 total nodes)"]);
  });

  test("a node missing from node.ls after add records confirmed:false and never syncs", async () => {
    const { client, calls } = makeClient({
      "llamactl.node.add": (args) =>
        args["dryRun"]
          ? { dryRun: true, message: "preview", node: { name: "gpu1" } }
          : { ok: true, name: "gpu1" },
      "llamactl.node.ls": () => ({
        context: "default",
        cluster: "home",
        nodes: [{ name: "local", kind: "agent" }],
      }),
    });

    const result = await runRunbook(
      "onboard-new-gpu-node",
      { name: "gpu1", bootstrap: "blob" },
      { dryRun: false, log: () => {}, toolClient: client },
    );

    expect(result).toStrictEqual({
      ok: false,
      steps: [
        {
          tool: "llamactl.node.add",
          dryRun: true,
          result: { dryRun: true, message: "preview", node: { name: "gpu1" } },
        },
        { tool: "llamactl.node.add", dryRun: false, result: { ok: true, name: "gpu1" } },
        { tool: "llamactl.node.ls", dryRun: false, result: { confirmed: false, totalNodes: 1 } },
      ],
      error: "node gpu1 not visible in kubeconfig after add",
    });

    expect(calls.map((c) => c.name)).toStrictEqual([
      "llamactl.node.add",
      "llamactl.node.add",
      "llamactl.node.ls",
    ]);
  });

  test("rejects an empty name and an empty bootstrap before any tool call", async () => {
    const { client, calls } = makeClient({});

    await expect(
      runRunbook(
        "onboard-new-gpu-node",
        { name: "", bootstrap: "b" },
        { dryRun: false, log: () => {}, toolClient: client },
      ),
    ).rejects.toThrow(/^runbook onboard-new-gpu-node: invalid params — /);

    await expect(
      runRunbook(
        "onboard-new-gpu-node",
        { name: "gpu1", bootstrap: "" },
        { dryRun: false, log: () => {}, toolClient: client },
      ),
    ).rejects.toThrow(/^runbook onboard-new-gpu-node: invalid params — /);

    expect(calls).toStrictEqual([]);
  });
});
