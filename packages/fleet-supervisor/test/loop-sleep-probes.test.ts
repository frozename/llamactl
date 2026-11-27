import { expect, test } from "bun:test";

import type { FleetJournalEntry, NodeMemSnapshot } from "../src/types.js";
import type { WorkloadTarget } from "../src/workload-probe.js";

import { startSupervisorLoop } from "../src/loop.js";

const NODE_MEM: NodeMemSnapshot = {
  free_mb: 8192,
  active_mb: 1024,
  inactive_mb: 512,
  wired_mb: 256,
  compressor_mb: 64,
  swap_in: 0,
  swap_out: 0,
};

const SLEEP_ENDPOINT = "http://127.0.0.1:8090";
const OTHER_ENDPOINT = "http://127.0.0.1:8091";
const target: WorkloadTarget = {
  name: "shared-name",
  kind: "ModelHost",
  endpoint: SLEEP_ENDPOINT,
  completionProbe: {
    path: "/v1/chat/completions",
    prompt: "ping",
    maxTokens: 1,
    timeoutMs: 100,
    everyNTicks: 1,
  },
};

for (const sleep of ["sleeping", "sleep-pending"] as const) {
  test(`recorded ${sleep} suppresses waking probes for only its exact supervisor target`, async () => {
    const contacts = new Map<string, string[]>();
    const entries: FleetJournalEntry[] = [];
    const fetch = Object.assign(
      (address: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(address instanceof Request ? address.url : address);
        const paths = contacts.get(url.origin) ?? [];
        paths.push(url.pathname);
        contacts.set(url.origin, paths);
        if (
          url.origin === SLEEP_ENDPOINT &&
          (url.pathname === "/health" ||
            url.pathname === "/v1/models" ||
            url.pathname === "/metrics")
        ) {
          expect(init?.redirect).toBe("error");
        }
        switch (url.pathname) {
          case "/v1/models":
            return Promise.resolve(Response.json({ data: [{ id: "model" }] }));
          case "/metrics":
            return Promise.resolve(new Response("llamacpp:prompt_tokens_total 120\n"));
          case "/slots":
            return Promise.resolve(Response.json([{ id: 0, is_processing: false }]));
          case "/v1/chat/completions":
          case "/health":
            return Promise.resolve(Response.json({ ok: true }));
          default:
            return Promise.resolve(new Response(null, { status: 404 }));
        }
      },
      { preconnect: (): void => undefined },
    );
    const options = {
      node: "local",
      once: true,
      workloads: [target, { ...target, endpoint: OTHER_ENDPOINT }],
      logSlotProgress: true,
      recordEngineThroughput: true,
      probeNodeMem: (): Promise<NodeMemSnapshot> => Promise.resolve(NODE_MEM),
      readRecordedSleep: ({ endpoint }: WorkloadTarget): Promise<typeof sleep> => {
        if (endpoint === OTHER_ENDPOINT) throw new Error("unrecognized owner");
        return Promise.resolve(sleep);
      },
      readLocalRevision: (): null => null,
      fetch,
      writeJournal: (entry: FleetJournalEntry): void => {
        entries.push(entry);
      },
    };
    await startSupervisorLoop(options).done;

    expect(contacts.get(SLEEP_ENDPOINT)?.toSorted()).toEqual(["/health", "/metrics", "/v1/models"]);
    expect(contacts.get(OTHER_ENDPOINT)?.toSorted()).toEqual([
      "/health",
      "/metrics",
      "/slots",
      "/slots",
      "/v1/chat/completions",
      "/v1/models",
    ]);
    const snapshot = entries.find((entry) => entry.kind === "fleet-snapshot");
    expect(snapshot?.workloads).toMatchObject([
      { endpoint: SLEEP_ENDPOINT, sleep, reachable: true, models: ["model"] },
      { endpoint: OTHER_ENDPOINT, reachable: true, completionProbe: { ran: true, ok: true } },
    ]);
    expect(snapshot?.workloads[0]?.completionProbe).toBeUndefined();
    expect(snapshot?.engineThroughput?.map((entry) => entry.slots)).toEqual([
      { available: false, reason: sleep },
      { available: true },
    ]);
    const progress = entries.filter((entry) => entry.kind === "fleet-slot-progress");
    expect(progress).toMatchObject([
      { available: false, reason: sleep, slots: [] },
      { available: true },
    ]);
  });
}

test("recorded sleep-pending preserves failed health without requesting restart", async () => {
  const entries: FleetJournalEntry[] = [];
  const fetch = Object.assign(
    (): Promise<Response> => Promise.resolve(new Response(null, { status: 503 })),
    { preconnect: (): void => undefined },
  );
  await startSupervisorLoop({
    node: "local",
    once: true,
    workloads: [target],
    degradationThresholds: {
      consecutiveErrorsForDegraded: 1,
      p95DegradedMs: 10,
      consecutiveCompletionErrorsForDegraded: 1,
    },
    probeNodeMem: (): Promise<NodeMemSnapshot> => Promise.resolve(NODE_MEM),
    readRecordedSleep: (): Promise<"sleep-pending"> => Promise.resolve("sleep-pending"),
    readLocalRevision: (): null => null,
    fetch,
    writeJournal: (entry): void => {
      entries.push(entry);
    },
  }).done;
  const snapshot = entries.find((entry) => entry.kind === "fleet-snapshot");
  expect(snapshot?.workloads[0]).toMatchObject({
    sleep: "sleep-pending",
    reachable: false,
    models: [],
    consecutiveErrors: 1,
  });
  expect(entries.some((entry) => entry.kind === "fleet-proposal")).toBe(false);
});
