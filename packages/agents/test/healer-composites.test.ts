/* eslint-disable @typescript-eslint/require-await -- mockClient's callTool must stay async to satisfy RunbookToolClient while the fake handlers return canned envelopes. */
import { describe, expect, test } from "bun:test";

import {
  type CompositeSummary,
  fetchComposites,
  formatCompositeReason,
  type RunbookToolClient,
  shouldRemediateComposite,
  type ToolCallInput,
} from "../src/index.js";

/**
 * Composite healer envelope parsing, normalization and remediation
 * reason formatting — mirrors facade-probe.test.ts structure:
 * mockClient(handler) + envelope(payload) + rejectionMessage(promise).
 */

function envelope(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function mockClient(handler: (input: ToolCallInput) => Promise<unknown>): RunbookToolClient {
  return {
    async callTool(input: ToolCallInput): Promise<unknown> {
      return await handler(input);
    },
  };
}

function textEnvelope(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (caught: unknown) => caught as Error,
  );
  expect(err).toBeInstanceOf(Error);
  return err!.message;
}

describe("fetchComposites call shape and envelope errors", () => {
  test("calls the tool with name 'llamactl.composite.list' and arguments {}", async () => {
    const inputs: ToolCallInput[] = [];
    const client = mockClient(async (input) => {
      inputs.push(input);
      return envelope({ composites: [] });
    });
    await fetchComposites(client);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({ name: "llamactl.composite.list", arguments: {} });
  });

  test("isError:true with a text block rejects with that text, truncated to 500 chars", async () => {
    const longMessage = await rejectionMessage(
      fetchComposites(
        mockClient(async () => ({
          isError: true,
          content: [{ type: "text", text: "x".repeat(600) }],
        })),
      ),
    );
    expect(longMessage.length).toBe(500);
    expect(longMessage).toBe("x".repeat(500));
  });

  test("isError:true with no content rejects with 'llamactl.composite.list returned isError'", async () => {
    const msg = await rejectionMessage(
      fetchComposites(
        mockClient(async () => ({
          isError: true,
          content: [],
        })),
      ),
    );
    expect(msg).toBe("llamactl.composite.list returned isError");
  });

  test("empty content array (not isError) rejects with 'missing text content block'", async () => {
    const msg = await rejectionMessage(fetchComposites(mockClient(async () => ({ content: [] }))));
    expect(msg).toBe("llamactl.composite.list: missing text content block");
  });

  test("first block of type 'image' (no text) rejects with 'missing text content block'", async () => {
    const msg = await rejectionMessage(
      fetchComposites(mockClient(async () => ({ content: [{ type: "image" }] }))),
    );
    expect(msg).toBe("llamactl.composite.list: missing text content block");
  });

  test("non-JSON text rejects with message starting 'llamactl.composite.list: JSON parse failed — '", async () => {
    const msg = await rejectionMessage(
      fetchComposites(mockClient(async () => textEnvelope("not json{"))),
    );
    expect(msg.startsWith("llamactl.composite.list: JSON parse failed — ")).toBe(true);
  });

  test("text 'null' (or a JSON number such as '42') rejects with 'envelope is not an object'", async () => {
    for (const text of ["null", "42"]) {
      const msg = await rejectionMessage(
        fetchComposites(mockClient(async () => textEnvelope(text))),
      );
      expect(msg).toBe("llamactl.composite.list: envelope is not an object");
    }
  });

  test("an envelope {} with no composites key resolves to []", async () => {
    const result = await fetchComposites(mockClient(async () => envelope({})));
    expect(result).toEqual([]);
  });
});

describe("fetchComposites normalization", () => {
  test("missing or empty metadata.name is dropped, named sibling is kept", async () => {
    const result = await fetchComposites(
      mockClient(async () =>
        envelope({
          composites: [
            { metadata: { name: "" } },
            { metadata: {} },
            { metadata: { name: "named" } },
          ],
        }),
      ),
    );
    const names = result.map((c) => c.name);
    expect(names).toEqual(["named"]);
  });

  test("recognised phase passes through; unrecognised or missing maps to 'Unknown'", async () => {
    const result = await fetchComposites(
      mockClient(async () =>
        envelope({
          composites: [
            { metadata: { name: "a" }, status: { phase: "Degraded" } },
            { metadata: { name: "b" }, status: { phase: "Exploding" } },
            { metadata: { name: "c" } },
          ],
        }),
      ),
    );
    expect(result.map((c) => c.phase)).toEqual(["Degraded", "Unknown", "Unknown"]);
  });

  test("unknown component ref.kind maps to 'service'; known kind passes through", async () => {
    const result = await fetchComposites(
      mockClient(async () =>
        envelope({
          composites: [
            {
              metadata: { name: "comp" },
              status: {
                components: [{ ref: { kind: "database" } }, { ref: { kind: "gateway" } }],
              },
            },
          ],
        }),
      ),
    );
    const comp0 = result.at(0)!;
    expect(comp0.components.map((c) => c.kind)).toEqual(["service", "gateway"]);
  });

  test("unknown component state or missing state maps to 'Pending'", async () => {
    const result = await fetchComposites(
      mockClient(async () =>
        envelope({
          composites: [
            {
              metadata: { name: "comp" },
              status: {
                components: [{ ref: { name: "c1" }, state: "Crashing" }, { ref: { name: "c2" } }],
              },
            },
          ],
        }),
      ),
    );
    const comp0 = result.at(0)!;
    expect(comp0.components.map((c) => c.state)).toEqual(["Pending", "Pending"]);
  });

  test("missing ref.name maps to name ''", async () => {
    const result = await fetchComposites(
      mockClient(async () =>
        envelope({
          composites: [
            {
              metadata: { name: "comp" },
              status: {
                components: [{ ref: {} }],
              },
            },
          ],
        }),
      ),
    );
    expect(result.at(0)!.components.at(0)!.name).toBe("");
  });

  test("message included when non-empty string; absent when '' or missing", async () => {
    const result = await fetchComposites(
      mockClient(async () =>
        envelope({
          composites: [
            {
              metadata: { name: "comp" },
              status: {
                components: [
                  { ref: { name: "a" }, message: "has message" },
                  { ref: { name: "b" }, message: "" },
                  { ref: { name: "c" } },
                ],
              },
            },
          ],
        }),
      ),
    );
    const comp = result.at(0)!;
    const c0 = comp.components.at(0)!;
    const c1 = comp.components.at(1)!;
    const c2 = comp.components.at(2)!;
    expect("message" in c0).toBe(true);
    expect(c0.message).toBe("has message");
    expect("message" in c1).toBe(false);
    expect("message" in c2).toBe(false);
  });

  test("missing status.components maps to components []", async () => {
    const result = await fetchComposites(
      mockClient(async () =>
        envelope({
          composites: [{ metadata: { name: "comp" } }],
        }),
      ),
    );
    expect(result.at(0)!.components).toEqual([]);
  });

  test("manifestYaml equals JSON.stringify(entry, null, 2) of the raw entry", async () => {
    const rawEntry = {
      apiVersion: "llamactl.io/v1",
      kind: "Composite",
      metadata: { name: "my-composite" },
      spec: { components: [{ name: "gw" }] },
      status: { phase: "Ready" },
    };
    const result = await fetchComposites(
      mockClient(async () => envelope({ composites: [rawEntry] })),
    );
    expect(result.at(0)!.manifestYaml).toBe(JSON.stringify(rawEntry, null, 2));
  });
});

describe("shouldRemediateComposite", () => {
  test("phase Degraded with all components Ready -> true", () => {
    const summary: CompositeSummary = {
      name: "sky",
      phase: "Degraded",
      components: [
        { kind: "service", name: "a", state: "Ready" },
        { kind: "service", name: "b", state: "Ready" },
      ],
      manifestYaml: "",
    };
    expect(shouldRemediateComposite(summary)).toBe(true);
  });

  test("phase Failed with no components -> true", () => {
    const summary: CompositeSummary = {
      name: "void",
      phase: "Failed",
      components: [],
      manifestYaml: "",
    };
    expect(shouldRemediateComposite(summary)).toBe(true);
  });

  test("phase Unknown even with a Failed component -> false", () => {
    const summary: CompositeSummary = {
      name: "ghost",
      phase: "Unknown",
      components: [{ kind: "service", name: "x", state: "Failed" }],
      manifestYaml: "",
    };
    expect(shouldRemediateComposite(summary)).toBe(false);
  });

  test("phase Ready with one Failed component -> true; Pending and Applying with Failed also -> true", () => {
    const withFailed: CompositeSummary = {
      name: "app",
      phase: "Ready",
      components: [
        { kind: "service", name: "a", state: "Failed" },
        { kind: "service", name: "b", state: "Ready" },
      ],
      manifestYaml: "",
    };
    expect(shouldRemediateComposite(withFailed)).toBe(true);

    const pendingFailed: CompositeSummary = {
      name: "app",
      phase: "Pending",
      components: [{ kind: "service", name: "a", state: "Failed" }],
      manifestYaml: "",
    };
    expect(shouldRemediateComposite(pendingFailed)).toBe(true);

    const applyingFailed: CompositeSummary = {
      name: "app",
      phase: "Applying",
      components: [{ kind: "service", name: "a", state: "Failed" }],
      manifestYaml: "",
    };
    expect(shouldRemediateComposite(applyingFailed)).toBe(true);
  });

  test("phase Ready with no Failed components -> false", () => {
    const summary: CompositeSummary = {
      name: "healthy",
      phase: "Ready",
      components: [
        { kind: "service", name: "a", state: "Ready" },
        { kind: "service", name: "b", state: "Pending" },
      ],
      manifestYaml: "",
    };
    expect(shouldRemediateComposite(summary)).toBe(false);
  });
});

describe("formatCompositeReason", () => {
  test("phase Degraded with 1 of 3 Failed -> 'composite sky reports Degraded (1/3 components Failed), re-applying'", () => {
    const summary: CompositeSummary = {
      name: "sky",
      phase: "Degraded",
      components: [
        { kind: "service", name: "a", state: "Failed" },
        { kind: "service", name: "b", state: "Ready" },
        { kind: "service", name: "c", state: "Ready" },
      ],
      manifestYaml: "",
    };
    expect(formatCompositeReason(summary)).toBe(
      "composite sky reports Degraded (1/3 components Failed), re-applying",
    );
  });

  test("phase Failed with zero components -> 'composite sky reports Failed, re-applying'", () => {
    const summary: CompositeSummary = {
      name: "sky",
      phase: "Failed",
      components: [],
      manifestYaml: "",
    };
    expect(formatCompositeReason(summary)).toBe("composite sky reports Failed, re-applying");
  });

  test("phase Ready with 2 of 2 Failed -> 'composite sky has 2/2 component(s) in Failed state, re-applying'", () => {
    const summary: CompositeSummary = {
      name: "sky",
      phase: "Ready",
      components: [
        { kind: "service", name: "a", state: "Failed" },
        { kind: "service", name: "b", state: "Failed" },
      ],
      manifestYaml: "",
    };
    expect(formatCompositeReason(summary)).toBe(
      "composite sky has 2/2 component(s) in Failed state, re-applying",
    );
  });
});
