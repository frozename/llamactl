// packages/app/e2e/credentials.spec.ts — #410 credentials sweep.
// A full session (fleet, nodes, workloads with both describe drawers,
// a live logs tail with a sentinel-bearing line) recorded into a HAR,
// then every credential-carrying surface scanned for the P2b-RED-9
// sentinels: HAR request URLs, HAR headers (minus the cookie /
// set-cookie headers, which carry only the session nonce), HAR
// response content texts, both page DOM serialisations, both web
// storages, document.cookie (empty: the session cookie is HttpOnly)
// and the session cookie itself. Kubeconfig tokens are covered by
// E2E_SENTINELS.kube (users[].token) and the rag endpoint password by
// E2E_SENTINELS.pg. Case-insensitive on purpose: redact.ts's BEARER
// rewrite can split "sentinel-bearer" (see the logs.spec.ts note).

import { readFileSync } from "node:fs";

import { E2E_CONSOLE_PORT, E2E_SENTINEL_VALUES, E2E_SENTINELS } from "./harness/fixtures/seed";
import { expect, test } from "./harness/fixtures/test";

const CONSOLE_ORIGIN = `http://127.0.0.1:${String(E2E_CONSOLE_PORT)}`;
const COOKIE_NAME = `llamactl_console_${String(E2E_CONSOLE_PORT)}`;
const FORBIDDEN_LITERALS = [`token: ${E2E_SENTINELS.kube}`, `rag:${E2E_SENTINELS.pg}@`] as const;

interface HarHeader {
  name: string;
  value: string;
}

interface HarEntry {
  request: { headers: HarHeader[]; url: string };
  response: { content?: { text?: string }; headers: HarHeader[] };
}

interface HarFile {
  log: { entries: HarEntry[] };
}

function withoutCookieHeader(headers: readonly HarHeader[]): HarHeader[] {
  return headers.filter((header) => header.name.toLowerCase() !== "cookie");
}

function withoutSetCookieHeader(headers: readonly HarHeader[]): HarHeader[] {
  return headers.filter((header) => header.name.toLowerCase() !== "set-cookie");
}

function sentinelsIn(text: string): string[] {
  const lower = text.toLowerCase();
  return E2E_SENTINEL_VALUES.filter((sentinel) => lower.includes(sentinel.toLowerCase()));
}

test("a full recorded session never carries a sentinel past the console projections", async ({
  browser,
  control,
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.getByTestId("console-view-fleet")).toBeVisible();

  const context = await browser.newContext({
    baseURL: CONSOLE_ORIGIN,
    recordHar: { content: "embed", path: testInfo.outputPath("session.har") },
  });
  const harPage = await context.newPage();
  const bodies: Promise<string>[] = [];
  harPage.on("response", (response) => {
    const contentType = response.headers()["content-type"] ?? "";
    if (!response.url().startsWith(CONSOLE_ORIGIN) || contentType.includes("text/event-stream")) {
      return;
    }
    bodies.push(response.text().catch(() => ""));
  });

  await harPage.goto("/");
  await expect(harPage.getByTestId("console-fleet-node-agent-off")).toContainText(
    "unreachable: e2e node unreachable",
  );

  await harPage.goto("/nodes");
  await expect(harPage.getByTestId("console-node-row-local")).toBeVisible();

  await harPage.goto("/workloads?node=agent-1");
  const wBRow = harPage.getByTestId("console-workload-row-wB");
  await expect(wBRow).toBeVisible();
  await wBRow.getByRole("button", { name: "Describe" }).click();
  await expect(wBRow.locator("pre").first()).toContainText("name: wB");
  await wBRow.getByRole("button", { name: "Hide" }).click();
  const multiRow = harPage.getByTestId("console-workload-row-wMulti");
  await multiRow.getByRole("button", { name: "Describe" }).click();
  await expect(multiRow.getByTestId("workloads-workers-panel")).toBeVisible();

  await harPage.goto("/logs/wB?node=agent-1");
  await expect(harPage.getByTestId("console-logs-conn")).toHaveAttribute(
    "data-state",
    "streaming",
    { timeout: 5_000 },
  );
  await control.emitLog("agent-1", "wB", `--api-key ${E2E_SENTINELS.log} cred-marker`);
  await expect(
    harPage.getByTestId("console-logs-line").filter({ hasText: "cred-marker" }),
  ).toBeVisible();

  const scanned: string[] = [
    await harPage.content(),
    await harPage.evaluate(() => document.documentElement.outerHTML),
  ];
  const storageEntries = await harPage.evaluate(() =>
    [
      ...Array.from({ length: window.localStorage.length }, (_unused, index) => {
        const key = window.localStorage.key(index) ?? "";
        return `${key}=${window.localStorage.getItem(key) ?? ""}`;
      }),
      ...Array.from({ length: window.sessionStorage.length }, (_unused, index) => {
        const key = window.sessionStorage.key(index) ?? "";
        return `${key}=${window.sessionStorage.getItem(key) ?? ""}`;
      }),
    ].join("\n"),
  );
  scanned.push(storageEntries);
  expect(await harPage.evaluate(() => document.cookie)).toBe("");

  const cookies = await context.cookies();
  expect(cookies).toHaveLength(1);
  const cookie = cookies[0];
  expect(cookie?.name).toBe(COOKIE_NAME);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  expect(sentinelsIn(cookie?.value ?? "")).toEqual([]);

  for (const pending of bodies) scanned.push(await pending);

  await harPage.goto("/workloads");
  await expect
    .poll(async () => (await control.streams("agent-1")).filter((entry) => entry.open).length, {
      timeout: 5_000,
    })
    .toBe(0);
  await context.close();

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path is this test's own Playwright output dir.
  const har = JSON.parse(readFileSync(testInfo.outputPath("session.har"), "utf8")) as HarFile;
  for (const entry of har.log.entries) {
    expect(sentinelsIn(entry.request.url)).toEqual([]);
    const headerText = [
      ...withoutCookieHeader(entry.request.headers),
      ...withoutSetCookieHeader(entry.response.headers),
    ]
      .map((header) => `${header.name}=${header.value}`)
      .join("\n");
    expect(sentinelsIn(headerText)).toEqual([]);
    expect(sentinelsIn(entry.response.content?.text ?? "")).toEqual([]);
  }

  const harText = JSON.stringify(har);
  const everything = [...scanned, harText];
  for (const sentinel of E2E_SENTINEL_VALUES) {
    for (const text of everything) {
      expect(text.toLowerCase()).not.toContain(sentinel.toLowerCase());
    }
  }
  for (const literal of FORBIDDEN_LITERALS) {
    for (const text of everything) {
      expect(text).not.toContain(literal);
    }
  }
});
