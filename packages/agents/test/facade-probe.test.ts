/* eslint-disable @typescript-eslint/require-await -- mockClient's callTool must stay async to satisfy RunbookToolClient while the fake handlers return canned envelopes. */
import { describe, expect, test } from "bun:test";

import { probeFleetViaNova, type RunbookToolClient, type ToolCallInput } from "../src/index.js";

/**
 * Envelope edge cases for probeFleetViaNova: the call shape sent to
 * the facade, every parse-error branch, and the exact field mapping
 * (status coercion, empty-string omission, probe ordering) that the
 * journal + transitions consumers depend on.
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

describe("probeFleetViaNova envelope edge cases", () => {
  test("calls nova.ops.healthcheck with empty arguments", async () => {
    const inputs: ToolCallInput[] = [];
    const client = mockClient(async (input) => {
      inputs.push(input);
      return envelope({});
    });
    await probeFleetViaNova(client);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({ name: "nova.ops.healthcheck", arguments: {} });
  });

  test("rejects when no usable text content block exists", async () => {
    const cases: unknown[] = [
      { content: [] },
      {},
      { content: [{ type: "image" }] },
      { content: [{ type: "text" }] },
    ];
    for (const payload of cases) {
      const client = mockClient(async () => payload);
      expect(await rejectionMessage(probeFleetViaNova(client))).toMatch(
        /missing text content block/,
      );
    }
  });

  test("rejects on unparseable JSON text", async () => {
    const client = mockClient(async () => textEnvelope("not json{"));
    expect(await rejectionMessage(probeFleetViaNova(client))).toMatch(/JSON parse failed/);
  });

  test("rejects when parsed text is not an object", async () => {
    for (const text of ["null", "42"]) {
      const client = mockClient(async () => textEnvelope(text));
      expect(await rejectionMessage(probeFleetViaNova(client))).toMatch(
        /envelope is not an object/,
      );
    }
  });

  test("missing gateway/provider lists yield an empty report; timeoutMs is dropped", async () => {
    const empty = await probeFleetViaNova(mockClient(async () => envelope({})));
    expect(empty.probes).toEqual([]);
    expect(empty.unhealthy).toBe(0);

    const withTimeout = await probeFleetViaNova(
      mockClient(async () => envelope({ timeoutMs: 1500 })),
    );
    expect("timeoutMs" in withTimeout).toBe(false);
  });

  test("isError envelopes reject with the downstream text, truncated to 500 chars", async () => {
    const bare = await rejectionMessage(
      probeFleetViaNova(
        mockClient(async () => ({
          isError: true,
          content: [],
        })),
      ),
    );
    expect(bare).toBe("nova.ops.healthcheck returned isError");

    const longMessage = await rejectionMessage(
      probeFleetViaNova(
        mockClient(async () => ({
          isError: true,
          content: [{ type: "text", text: "x".repeat(600) }],
        })),
      ),
    );
    expect(longMessage.length).toBe(500);
  });

  test("non-numeric status coerces to 0; empty error string is omitted", async () => {
    const report = await probeFleetViaNova(
      mockClient(async () =>
        envelope({
          gateways: [
            {
              name: "g-str",
              baseUrl: "http://g-str/v1",
              ok: true,
              status: "200" as unknown,
            },
            { name: "g-empty", baseUrl: "http://g-empty/v1", ok: false, status: 503, error: "" },
          ],
        }),
      ),
    );
    const strProbe = report.probes.find((p) => p.name === "g-str")!;
    const emptyProbe = report.probes.find((p) => p.name === "g-empty")!;
    expect(strProbe.status).toBe(0);
    expect(emptyProbe.state).toBe("unhealthy");
    expect("error" in emptyProbe).toBe(false);
  });

  test("empty provider kind is omitted; gateways never carry providerKind", async () => {
    const report = await probeFleetViaNova(
      mockClient(async () =>
        envelope({
          gateways: [{ name: "g1", baseUrl: "http://g1/v1", ok: true, status: 200 }],
          siriusProviders: [
            { name: "p-blank", kind: "", baseUrl: "http://p/v1", ok: true, status: 200 },
          ],
        }),
      ),
    );
    const gw = report.probes.find((p) => p.name === "g1")!;
    const prov = report.probes.find((p) => p.name === "p-blank")!;
    expect("providerKind" in gw).toBe(false);
    expect("providerKind" in prov).toBe(false);
  });

  test("latencyMs is 0 and probe order is gateways then providers", async () => {
    const report = await probeFleetViaNova(
      mockClient(async () =>
        envelope({
          gateways: [
            { name: "g1", baseUrl: "http://g1/v1", ok: true, status: 200 },
            { name: "g2", baseUrl: "http://g2/v1", ok: false, status: 502, error: "bad" },
          ],
          siriusProviders: [
            { name: "p1", kind: "openai", baseUrl: "http://p1/v1", ok: false, status: 500 },
            { name: "p2", kind: "anthropic", baseUrl: "http://p2/v1", ok: true, status: 200 },
          ],
        }),
      ),
    );
    expect(report.probes.map((p) => p.name)).toEqual(["g1", "g2", "p1", "p2"]);
    for (const probe of report.probes) {
      expect(probe.latencyMs).toBe(0);
    }
  });

  test("unhealthy counts ok:false entries across both lists", async () => {
    const report = await probeFleetViaNova(
      mockClient(async () =>
        envelope({
          gateways: [
            { name: "g1", baseUrl: "http://g1/v1", ok: true, status: 200 },
            { name: "g2", baseUrl: "http://g2/v1", ok: false, status: 502, error: "bad" },
          ],
          siriusProviders: [
            { name: "p1", kind: "openai", baseUrl: "http://p1/v1", ok: false, status: 500 },
            { name: "p2", kind: "anthropic", baseUrl: "http://p2/v1", ok: true, status: 200 },
          ],
        }),
      ),
    );
    expect(report.probes).toHaveLength(4);
    expect(report.unhealthy).toBe(2);
  });

  test("report.ts round-trips through ISO parsing", async () => {
    const report = await probeFleetViaNova(mockClient(async () => envelope({})));
    expect(new Date(report.ts).toISOString()).toBe(report.ts);
  });
});
