// packages/app/e2e/session.spec.ts — #410 P5b part 2a.
// Session + guard behavior on the console server: a dropped cookie
// surfaces the reload banner on the next fetch without any navigation,
// and the /api mount enforces Sec-Fetch-Site/Origin, the procedure
// allowlist (single and batched), the session cookie and redaction —
// proven through page.request bodies, which the auto sentinel guard
// cannot see.

import type { APIResponse } from "@playwright/test";

import { E2E_CONSOLE_PORT, E2E_NODE_FACTS, E2E_SENTINEL_VALUES } from "./harness/fixtures/seed";
import { expect, test } from "./harness/fixtures/test";

const INVALID_SESSION_MESSAGE = "Console restarted or session expired — reload";
const NODE_LIST = "/api/n/local/trpc/nodeList";
const APPLY = "/api/n/local/trpc/workloadApply";
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

interface BatchItem {
  error?: { message?: string };
  result?: { data?: { error?: string; ok?: boolean } };
}

function parsedError(text: string): unknown {
  return JSON.parse(text) as unknown;
}

test("a dropped cookie surfaces the reload banner without a reload", async ({ page }) => {
  await page.goto("/workloads");
  const row = page.getByTestId("console-workload-row-wA");
  await expect(row).toBeVisible();
  await page.context().clearCookies();
  await row.getByRole("button", { name: "Describe" }).click();
  await expect(page.getByRole("alert")).toHaveText(INVALID_SESSION_MESSAGE);
});

test("the api mount guards origin, allowlist, batch and session", async ({
  control,
  page,
  playwright,
}) => {
  await page.goto("/");
  const bodies: string[] = [];

  const listRes = await page.request.get(NODE_LIST, { headers: SAME_ORIGIN });
  expect(listRes.status()).toBe(200);
  bodies.push(await listRes.text());

  const crossRes = await page.request.get(NODE_LIST, {
    headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" },
  });
  expect(crossRes.status()).toBe(403);
  const crossBody = await crossRes.text();
  bodies.push(crossBody);
  expect(parsedError(crossBody)).toEqual({ error: "cross_site_request_forbidden" });

  const evilOrigin = await page.request.get(NODE_LIST, {
    headers: { origin: "http://evil.example", ...SAME_ORIGIN },
  });
  expect(evilOrigin.status()).toBe(403);
  bodies.push(await evilOrigin.text());

  const applyRes = await page.request.get(APPLY, { headers: SAME_ORIGIN });
  expect(applyRes.status()).toBe(404);
  const applyBody = await applyRes.text();
  bodies.push(applyBody);
  expect(parsedError(applyBody)).toEqual({ error: "procedure_not_exposed" });

  const batchRes = await page.request.get(`${NODE_LIST},workloadApply?batch=1&input=%7B%7D`, {
    headers: SAME_ORIGIN,
  });
  expect(batchRes.status()).toBe(404);
  const batchBody = await batchRes.text();
  bodies.push(batchBody);
  expect(parsedError(batchBody)).toEqual({ error: "procedure_not_exposed" });

  const localCalls = await control.calls("local");
  expect(localCalls.some((call) => call.procedure === "workloadApply")).toBe(false);

  const anon = await playwright.request.newContext({
    baseURL: `http://127.0.0.1:${String(E2E_CONSOLE_PORT)}`,
  });
  const anonRes: APIResponse = await anon.get(NODE_LIST, { headers: SAME_ORIGIN });
  expect(anonRes.status()).toBe(401);
  const anonBody = await anonRes.text();
  await anon.dispose();
  bodies.push(anonBody);
  expect(parsedError(anonBody)).toEqual({ error: "invalid_session" });

  for (const body of bodies) {
    for (const sentinel of E2E_SENTINEL_VALUES) {
      expect(body).not.toContain(sentinel);
    }
  }
});

// Pinned after #482 let the console guard accept repeated procedures:
// the fleet/nodes views fold their per-row nodeTest probes into one
// batch, and the harness must not rewrite that request. The old guard
// answered 400 bad_batch here. The URL is absolute on purpose: page
// .request joins a comma-bearing relative path onto the config baseURL
// segment-by-segment, which is not what the browser client sends.
test("a repeated-procedure batch is served per segment unaided", async ({ control, page }) => {
  await page.goto("/");
  // The fleet view fires one load-time nodeTest probe per tile at the
  // tab node, and each probe lands in the same recorded-call log as the
  // manual batch. Let every tile settle (a settled label proves the
  // probe was recorded server-side), then clear the log so the counts
  // below pin the manual batch alone.
  for (const name of ["local", "agent-1", "gw-1", "ragdb"]) {
    await expect(
      page.getByTestId(`console-fleet-node-${name}`).getByText("reachable", { exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByTestId("console-fleet-node-agent-off")).toContainText(
    "unreachable: e2e node unreachable",
  );
  await control.reset();
  const input = encodeURIComponent(
    JSON.stringify({ "0": { name: "agent-1" }, "1": { name: "agent-off" } }),
  );
  const batchRes = await page.request.get(
    `http://127.0.0.1:${String(E2E_CONSOLE_PORT)}/api/n/local/trpc/nodeTest,nodeTest?batch=1&input=${input}`,
    { headers: SAME_ORIGIN },
  );
  expect(batchRes.status()).toBe(200);
  const batchBody = await batchRes.text();
  const items = JSON.parse(batchBody) as BatchItem[];
  expect(items).toHaveLength(2);
  expect(items[0]?.result?.data).toEqual({ facts: E2E_NODE_FACTS, ok: true });
  expect(items[1]?.result?.data).toEqual({ error: "e2e node unreachable", ok: false });
  for (const sentinel of E2E_SENTINEL_VALUES) {
    expect(batchBody).not.toContain(sentinel);
  }

  const probeInputs = (await control.calls("local"))
    .filter((call) => call.procedure === "nodeTest")
    .map((call) => JSON.stringify(call.input));
  expect(probeInputs).toContain('{"name":"agent-1"}');
  expect(probeInputs).toContain('{"name":"agent-off"}');
  expect(probeInputs.filter((value) => value === '{"name":"agent-1"}')).toHaveLength(1);
  expect(probeInputs.filter((value) => value === '{"name":"agent-off"}')).toHaveLength(1);
  expect(probeInputs).toHaveLength(2);
});
