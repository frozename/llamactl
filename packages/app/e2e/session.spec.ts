// packages/app/e2e/session.spec.ts — #410 P5b part 2a.
// Session + guard behavior on the console server: a dropped cookie
// surfaces the reload banner on the next fetch without any navigation,
// and the /api mount enforces Sec-Fetch-Site/Origin, the procedure
// allowlist (single and batched), the session cookie and redaction —
// proven through page.request bodies, which the auto sentinel guard
// cannot see.

import type { APIResponse } from "@playwright/test";

import { E2E_CONSOLE_PORT, E2E_SENTINEL_VALUES } from "./harness/fixtures/seed";
import { expect, test } from "./harness/fixtures/test";

const INVALID_SESSION_MESSAGE = "Console restarted or session expired — reload";
const NODE_LIST = "/api/n/local/trpc/nodeList";
const APPLY = "/api/n/local/trpc/workloadApply";
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

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
