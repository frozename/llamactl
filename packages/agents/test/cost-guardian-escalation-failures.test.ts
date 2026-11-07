/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/explicit-function-return-type, @typescript-eslint/unbound-method -- Test fixtures unwrap journal JSON and synchronous fake tool calls. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CostGuardianConfig,
  CostGuardianConfigSchema,
  type RunbookToolClient,
  runCostGuardianTick,
  type ToolCallInput,
  type WebhookFetcher,
} from "../src/index.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";

/**
 * Escalation failure tests for the cost-guardian tick. Covers:
 *  - tier-2 wet-run returning ok:false (blocks tier-3)
 *  - tier-2 wet-run throwing (blocks tier-3)
 *  - tier-2 wet-run ok:false without reason/message (carries availableProfiles)
 *  - tier-3 deregister wet-run ok:false (reason + mapped detail)
 *  - tier-3 deregister wet-run throwing (toolInvoked:false)
 *  - both auto flags succeeding (full dry→wet call sequence + journal)
 *  - skipJournal on a deregister-tier tick (webhook fires, no escalation, no journal)
 *  - byProvider[0] position selects the deregister target (not highest spender)
 */

describe("runCostGuardianTick — escalation failures and ordering", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "guardian-esc-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Partial<CostGuardianConfig> = {}): CostGuardianConfig {
    return CostGuardianConfigSchema.parse({
      budget: { daily_usd: 10 },
      ...overrides,
    });
  }

  function now(): Date {
    return new Date("2026-11-01T00:00:00.000Z");
  }

  function makeFakeClient(
    handler: (
      input: ToolCallInput,
    ) =>
      | Promise<{ content: { type: string; text: string }[] }>
      | { content: { type: string; text: string }[] },
  ): RunbookToolClient & { getCalls: () => ToolCallInput[] } {
    const calls: ToolCallInput[] = [];
    return {
      async callTool(input: ToolCallInput) {
        calls.push(input);
        const result = await handler(input);
        return result;
      },
      getCalls(): ToolCallInput[] {
        return calls;
      },
    };
  }

  function readJournal(path: string): Record<string, unknown>[] {
    const body = readFileSync(path, "utf8").trim();
    return body.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  const snapshotPayload = {
    totalEstimatedCostUsd: 9.8,
    windowSince: "x",
    windowUntil: "y",
    byProvider: [{ key: "openrouter-paid", estimatedCostUsd: 9.7 }],
  };

  test("failed tier-2 wet-run (ok:false) blocks the tier-3 wet-run in the same tick", async () => {
    const { callTool, getCalls } = makeFakeClient(async (input) => {
      if (input.name === "nova.ops.cost.snapshot") {
        return { content: [{ type: "text", text: JSON.stringify(snapshotPayload) }] };
      }
      if (input.name === "llamactl.embersynth.set-default-profile") {
        if (input.arguments["dryRun"]) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  mode: "dry-run",
                  previous: "auto",
                  next: "private-first",
                  unchanged: false,
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                reason: "profile-locked",
                message: "held by operator",
              }),
            },
          ],
        };
      }
      if (input.name === "sirius.providers.deregister") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                mode: "dry-run",
                wasPresent: true,
                remainingCount: 2,
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected: ${input.name}`);
    });
    const journalPath = join(dir, "cg.jsonl");
    await runCostGuardianTick({
      tools: { callTool },
      config: makeConfig({ auto_force_private: true, auto_deregister: true }),
      journalPath,
      now,
      disableWebhook: true,
    });
    const calls = getCalls();
    const profileCalls = calls.filter((c) => c.name === "llamactl.embersynth.set-default-profile");
    expect(profileCalls).toHaveLength(2);
    expect(profileCalls[0]!.arguments["dryRun"]).toBe(true);
    expect(profileCalls[1]!.arguments["dryRun"]).toBe(false);
    const deregCalls = calls.filter((c) => c.name === "sirius.providers.deregister");
    expect(deregCalls).toHaveLength(1);
    expect(deregCalls[0]!.arguments).toEqual({ name: "openrouter-paid", dryRun: true });
    const entries = readJournal(journalPath);
    const forceWet = entries.find((e) => e["action"] === "force-private-wet");
    expect(forceWet).toBeDefined();
    const fw = forceWet!;
    expect(fw["ok"]).toBe(false);
    expect(fw["error"]).toBe("profile-locked: held by operator");
    expect((fw["detail"] as { toolInvoked: boolean }).toolInvoked).toBe(true);
    expect(fw["ts"]).toBe("2026-11-01T00:00:00.000Z");
    const deregDry = entries.find((e) => e["action"] === "deregister-dry-run");
    expect(deregDry).toBeDefined();
    expect(deregDry!["ok"]).toBe(true);
    const deregWetEntries = entries.filter((e) => e["action"] === "deregister-wet");
    expect(deregWetEntries).toHaveLength(0);
    const deregRefusedEntries = entries.filter((e) => e["action"] === "deregister-refused");
    expect(deregRefusedEntries).toHaveLength(0);
  });

  test("throwing tier-2 wet-run is journaled with toolInvoked:false and still blocks tier-3", async () => {
    const { callTool, getCalls } = makeFakeClient(async (input) => {
      if (input.name === "nova.ops.cost.snapshot") {
        return { content: [{ type: "text", text: JSON.stringify(snapshotPayload) }] };
      }
      if (input.name === "llamactl.embersynth.set-default-profile") {
        if (input.arguments["dryRun"]) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  mode: "dry-run",
                  previous: "auto",
                  next: "private-first",
                  unchanged: false,
                }),
              },
            ],
          };
        }
        throw new Error("socket closed");
      }
      if (input.name === "sirius.providers.deregister") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                mode: "dry-run",
                wasPresent: true,
                remainingCount: 2,
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected: ${input.name}`);
    });
    const journalPath = join(dir, "cg.jsonl");
    await runCostGuardianTick({
      tools: { callTool },
      config: makeConfig({ auto_force_private: true, auto_deregister: true }),
      journalPath,
      now,
      disableWebhook: true,
    });
    const calls = getCalls();
    const deregCalls = calls.filter((c) => c.name === "sirius.providers.deregister");
    expect(deregCalls).toHaveLength(1);
    expect(deregCalls[0]!.arguments).toEqual({ name: "openrouter-paid", dryRun: true });
    const entries = readJournal(journalPath);
    const forceWet = entries.find((e) => e["action"] === "force-private-wet");
    expect(forceWet).toBeDefined();
    const fw = forceWet!;
    expect(fw["error"]).toBe(
      "llamactl.embersynth.set-default-profile wet-run failed \u2014 socket closed",
    );
    const wetDetail = fw["detail"] as {
      autoForcePrivateEnabled: boolean;
      targetProfile: string;
      syntheticModel: string;
      toolInvoked: boolean;
    };
    expect(wetDetail.autoForcePrivateEnabled).toBe(true);
    expect(wetDetail.targetProfile).toBe("private-first");
    expect(wetDetail.syntheticModel).toBe("fusion-auto");
    expect(wetDetail.toolInvoked).toBe(false);
  });

  test("tier-2 wet-run ok:false without reason/message falls back and carries availableProfiles", async () => {
    const { callTool, getCalls } = makeFakeClient(async (input) => {
      if (input.name === "nova.ops.cost.snapshot") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                totalEstimatedCostUsd: 8.5,
                windowSince: "x",
                windowUntil: "y",
              }),
            },
          ],
        };
      }
      if (input.name === "llamactl.embersynth.set-default-profile") {
        if (input.arguments["dryRun"]) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  mode: "dry-run",
                  previous: "auto",
                  next: "private-first",
                  unchanged: false,
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, availableProfiles: ["auto", "private-first"] }),
            },
          ],
        };
      }
      if (input.name === "sirius.providers.deregister") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                mode: "dry-run",
                wasPresent: true,
                remainingCount: 2,
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected: ${input.name}`);
    });
    const journalPath = join(dir, "cg.jsonl");
    await runCostGuardianTick({
      tools: { callTool },
      config: makeConfig({ auto_force_private: true, auto_deregister: true }),
      journalPath,
      now,
      disableWebhook: true,
    });
    const entries = readJournal(journalPath);
    const forceWet = entries.find((e) => e["action"] === "force-private-wet");
    expect(forceWet).toBeDefined();
    const fw = forceWet!;
    expect(fw["error"]).toBe("unknown: no message");
    const wetDetail = fw["detail"] as {
      availableProfiles?: string[];
      mode: unknown;
      previous: unknown;
      next: unknown;
      unchanged: unknown;
    };
    expect(wetDetail.availableProfiles).toEqual(["auto", "private-first"]);
    expect(wetDetail.mode).toBeNull();
    expect(wetDetail.previous).toBeNull();
    expect(wetDetail.next).toBeNull();
    expect(wetDetail.unchanged).toBeNull();
  });

  test("tier-3 deregister wet-run ok:false is journaled with reason and mapped detail", async () => {
    const { callTool, getCalls } = makeFakeClient(async (input) => {
      if (input.name === "nova.ops.cost.snapshot") {
        return { content: [{ type: "text", text: JSON.stringify(snapshotPayload) }] };
      }
      if (input.name === "llamactl.embersynth.set-default-profile") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                mode: "dry-run",
                previous: "auto",
                next: "private-first",
                unchanged: false,
              }),
            },
          ],
        };
      }
      if (input.name === "sirius.providers.deregister") {
        if (input.arguments["dryRun"]) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  mode: "dry-run",
                  wasPresent: true,
                  remainingCount: 2,
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                mode: "wet",
                wasPresent: false,
                remainingCount: 3,
                reason: "not-found",
                message: "no such provider",
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected: ${input.name}`);
    });
    const journalPath = join(dir, "cg.jsonl");
    await runCostGuardianTick({
      tools: { callTool },
      config: makeConfig({ auto_deregister: true }),
      journalPath,
      now,
      disableWebhook: true,
    });
    const entries = readJournal(journalPath);
    const deregWet = entries.find((e) => e["action"] === "deregister-wet");
    expect(deregWet).toBeDefined();
    const dw = deregWet!;
    expect(dw["ok"]).toBe(false);
    expect(dw["error"]).toBe("not-found: no such provider");
    const wetDetail = dw["detail"] as {
      provider: string;
      autoDeregisterEnabled: boolean;
      toolInvoked: boolean;
      mode: string;
      wasPresent: boolean;
      remainingCount: number;
    };
    expect(wetDetail.provider).toBe("openrouter-paid");
    expect(wetDetail.autoDeregisterEnabled).toBe(true);
    expect(wetDetail.toolInvoked).toBe(true);
    expect(wetDetail.mode).toBe("wet");
    expect(wetDetail.wasPresent).toBe(false);
    expect(wetDetail.remainingCount).toBe(3);
  });

  test("throwing tier-3 deregister wet-run is journaled with toolInvoked:false", async () => {
    const { callTool, getCalls } = makeFakeClient(async (input) => {
      if (input.name === "nova.ops.cost.snapshot") {
        return { content: [{ type: "text", text: JSON.stringify(snapshotPayload) }] };
      }
      if (input.name === "llamactl.embersynth.set-default-profile") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                mode: "dry-run",
                previous: "auto",
                next: "private-first",
                unchanged: false,
              }),
            },
          ],
        };
      }
      if (input.name === "sirius.providers.deregister") {
        if (input.arguments["dryRun"]) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  mode: "dry-run",
                  wasPresent: true,
                  remainingCount: 2,
                }),
              },
            ],
          };
        }
        throw new Error("boom");
      }
      throw new Error(`unexpected: ${input.name}`);
    });
    const journalPath = join(dir, "cg.jsonl");
    await runCostGuardianTick({
      tools: { callTool },
      config: makeConfig({ auto_deregister: true }),
      journalPath,
      now,
      disableWebhook: true,
    });
    const entries = readJournal(journalPath);
    const deregWet = entries.find((e) => e["action"] === "deregister-wet");
    expect(deregWet).toBeDefined();
    const dw = deregWet!;
    expect(dw["error"]).toBe("sirius.providers.deregister wet-run failed \u2014 boom");
    const wetDetail = dw["detail"] as {
      provider: string;
      autoDeregisterEnabled: boolean;
      toolInvoked: boolean;
    };
    expect(wetDetail.provider).toBe("openrouter-paid");
    expect(wetDetail.autoDeregisterEnabled).toBe(true);
    expect(wetDetail.toolInvoked).toBe(false);
  });

  test("both auto flags succeed: calls and journal entries follow dry→wet order per tier", async () => {
    const { callTool, getCalls } = makeFakeClient(async (input) => {
      if (input.name === "nova.ops.cost.snapshot") {
        return { content: [{ type: "text", text: JSON.stringify(snapshotPayload) }] };
      }
      if (input.name === "llamactl.embersynth.set-default-profile") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                mode: input.arguments["dryRun"] ? "dry-run" : "wet",
                previous: "auto",
                next: "private-first",
                unchanged: false,
              }),
            },
          ],
        };
      }
      if (input.name === "sirius.providers.deregister") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                mode: input.arguments["dryRun"] ? "dry-run" : "wet",
                wasPresent: true,
                remainingCount: 2,
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected: ${input.name}`);
    });
    const journalPath = join(dir, "cg.jsonl");
    await runCostGuardianTick({
      tools: { callTool },
      config: makeConfig({ auto_force_private: true, auto_deregister: true }),
      journalPath,
      now,
      disableWebhook: true,
    });
    const calls = getCalls();
    const callPairs = calls.map(
      (c) =>
        [c.name, (c.arguments["dryRun"] ?? null) as boolean | null] as [string, boolean | null],
    );
    expect(callPairs).toEqual([
      ["nova.ops.cost.snapshot", null],
      ["llamactl.embersynth.set-default-profile", true],
      ["llamactl.embersynth.set-default-profile", false],
      ["sirius.providers.deregister", true],
      ["sirius.providers.deregister", false],
    ]);
    const entries = readJournal(journalPath);
    const actionLabels = entries.map((e) =>
      e["kind"] === "tick" ? "tick" : (e["action"] as string),
    );
    expect(actionLabels).toEqual([
      "tick",
      "force-private",
      "force-private-wet",
      "deregister-dry-run",
      "deregister-wet",
    ]);
  });

  test("skipJournal on a deregister-tier tick posts the webhook but runs no escalation tool and writes no journal", async () => {
    const webhookCalls: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    }[] = [];
    const fetcher: WebhookFetcher = async (url, init) => {
      webhookCalls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return { ok: true, status: 204 };
    };
    const { callTool, getCalls } = makeFakeClient(async (input) => {
      if (input.name === "nova.ops.cost.snapshot") {
        return { content: [{ type: "text", text: JSON.stringify(snapshotPayload) }] };
      }
      if (input.name === "llamactl.embersynth.set-default-profile") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                mode: "dry-run",
                previous: "auto",
                next: "private-first",
                unchanged: false,
              }),
            },
          ],
        };
      }
      if (input.name === "sirius.providers.deregister") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                mode: "dry-run",
                wasPresent: true,
                remainingCount: 2,
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected: ${input.name}`);
    });
    const journalPath = join(dir, "cg.jsonl");
    const decision = await runCostGuardianTick({
      tools: { callTool },
      config: makeConfig({
        auto_force_private: true,
        auto_deregister: true,
        webhook_url: "https://example.com/cost-alerts",
      }),
      journalPath,
      now,
      skipJournal: true,
      webhookFetcher: fetcher,
    });
    expect(decision.tier).toBe("deregister");
    expect(decision.deregisterTarget).toBe("openrouter-paid");
    const calls = getCalls();
    expect(calls).toHaveLength(1);
    const c0 = calls[0]!;
    expect(c0.name).toBe("nova.ops.cost.snapshot");
    expect(c0.arguments).toEqual({ days: 1 });
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]!.method).toBe("POST");
    expect(existsSync(journalPath)).toBe(false);
  });

  test("deregister target is byProvider[0] by position, not the highest spender, and needs no estimatedCostUsd", async () => {
    const { callTool, getCalls } = makeFakeClient(async (input) => {
      if (input.name === "nova.ops.cost.snapshot") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                totalEstimatedCostUsd: 9.8,
                windowSince: "x",
                windowUntil: "y",
                byProvider: [
                  { key: "first-listed" },
                  { key: "bigger-spender", estimatedCostUsd: 9.7 },
                ],
              }),
            },
          ],
        };
      }
      if (input.name === "llamactl.embersynth.set-default-profile") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                mode: "dry-run",
                previous: "auto",
                next: "private-first",
                unchanged: false,
              }),
            },
          ],
        };
      }
      if (input.name === "sirius.providers.deregister") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                mode: "dry-run",
                wasPresent: true,
                remainingCount: 2,
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected: ${input.name}`);
    });
    const journalPath = join(dir, "cg.jsonl");
    await runCostGuardianTick({
      tools: { callTool },
      config: makeConfig({ auto_deregister: false }),
      journalPath,
      now,
      disableWebhook: true,
    });
    const calls = getCalls();
    const deregCalls = calls.filter((c) => c.name === "sirius.providers.deregister");
    expect(deregCalls).toHaveLength(1);
    expect(deregCalls[0]!.arguments).toEqual({ name: "first-listed", dryRun: true });
  });
});
