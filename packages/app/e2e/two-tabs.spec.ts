// packages/app/e2e/two-tabs.spec.ts — #410 T5.
// Two log tabs in one browser context, tails on two different nodes,
// while a stop runs against tab A's node.
//
// Scope notes:
// - The stop runs from a third tab on agent-1: the logs view has no
//   Stop control, and navigating either log tab away would tear its
//   tail down, so neither log page can host the stop dialog.
// - The fixture's serverStop does not end serverLogs streams, so this
//   spec pins isolation (the stop lands on the correct node only and
//   the other tail is undisturbed), not stream termination.
// - Loading with ?node= does not write sessionStorage (only the
//   title-bar picker persists), so per-tab node scope is proven
//   through the URL, the recorded calls and the request paths.

import type { Page } from "@playwright/test";

import type { ControlClient } from "./harness/fixtures/test";

import { E2E_CONSOLE_PORT, E2E_PID, E2E_SENTINEL_VALUES } from "./harness/fixtures/seed";
import { expect, test } from "./harness/fixtures/test";

const CONSOLE_ORIGIN = `http://127.0.0.1:${String(E2E_CONSOLE_PORT)}`;

function inputWorkload(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const workload: unknown = (input as { workload?: unknown }).workload;
  return typeof workload === "string" ? workload : "";
}

function watchRequests(page: Page, sink: string[]): void {
  page.on("request", (request) => {
    sink.push(request.url());
  });
}

function watchBodies(page: Page, sink: Promise<string>[]): void {
  page.on("response", (response) => {
    const contentType = response.headers()["content-type"] ?? "";
    if (!response.url().startsWith(CONSOLE_ORIGIN) || contentType.includes("text/event-stream")) {
      return;
    }
    sink.push(response.text().catch(() => ""));
  });
}

async function pollOpenStream(
  control: ControlClient,
  node: string,
  workload: string,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await control.streams(node)).some((entry) => entry.open && entry.workload === workload),
      { timeout: 5_000 },
    )
    .toBe(true);
}

test("two log tails stream independently while a stop lands on its own node", async ({
  control,
  page,
}) => {
  const requestsA: string[] = [];
  const requestsB: string[] = [];
  const bodiesB: Promise<string>[] = [];
  const bodiesStop: Promise<string>[] = [];

  const tabB = await page.context().newPage();
  const stopTab = await page.context().newPage();
  watchRequests(page, requestsA);
  watchRequests(tabB, requestsB);
  watchBodies(tabB, bodiesB);
  watchBodies(stopTab, bodiesStop);

  await page.goto("/logs/wB?node=agent-1");
  await tabB.goto("/logs/wA?node=local");

  const connA = page.getByTestId("console-logs-conn");
  const connB = tabB.getByTestId("console-logs-conn");
  await expect(connA).toHaveAttribute("data-state", "streaming", { timeout: 5_000 });
  await expect(connB).toHaveAttribute("data-state", "streaming", { timeout: 5_000 });
  await pollOpenStream(control, "agent-1", "wB");
  await pollOpenStream(control, "local", "wA");

  await control.setServerStopMode("ok");
  await stopTab.goto("/workloads?node=agent-1");
  await stopTab
    .getByTestId("console-workload-row-wB")
    .getByRole("button", { name: "Stop" })
    .click();
  const dialog = stopTab.getByRole("dialog", { name: "Stop wB" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill("wB");
  await dialog.getByRole("button", { name: "Stop" }).click();
  await expect(stopTab.getByRole("status")).toContainText(
    `Stopped llama-server (PID ${String(E2E_PID)})`,
  );

  const agentStops = (await control.calls("agent-1")).filter(
    (call) => call.procedure === "serverStop",
  );
  expect(agentStops).toEqual([
    { input: { graceSeconds: 5, workload: "wB" }, node: "agent-1", procedure: "serverStop" },
  ]);
  const localStops = (await control.calls("local")).filter(
    (call) => call.procedure === "serverStop",
  );
  expect(localStops).toEqual([]);

  await expect(connA).toHaveAttribute("data-state", "streaming");
  await expect(connB).toHaveAttribute("data-state", "streaming");
  await pollOpenStream(control, "agent-1", "wB");
  await pollOpenStream(control, "local", "wA");

  const markerA = "two-tabs-marker-on-agent-1";
  const markerB = "two-tabs-marker-on-local";
  await control.emitLog("agent-1", "wB", markerA);
  await control.emitLog("local", "wA", markerB);
  await expect(page.getByTestId("console-logs-line").filter({ hasText: markerA })).toBeVisible();
  await expect(tabB.getByTestId("console-logs-line").filter({ hasText: markerB })).toBeVisible();
  await expect(tabB.getByTestId("console-logs-line").filter({ hasText: markerA })).toHaveCount(0);
  await expect(page.getByTestId("console-logs-line").filter({ hasText: markerB })).toHaveCount(0);

  const agentLogs = (await control.calls("agent-1"))
    .filter((call) => call.procedure === "serverLogs")
    .map((call) => inputWorkload(call.input));
  expect(agentLogs.length).toBeGreaterThan(0);
  expect(agentLogs.every((workload) => workload === "wB")).toBe(true);
  const localLogs = (await control.calls("local"))
    .filter((call) => call.procedure === "serverLogs")
    .map((call) => inputWorkload(call.input));
  expect(localLogs.length).toBeGreaterThan(0);
  expect(localLogs.every((workload) => workload === "wA")).toBe(true);

  expect(await page.evaluate(() => sessionStorage.getItem("llamactl-console-node"))).toBeNull();
  expect(await tabB.evaluate(() => sessionStorage.getItem("llamactl-console-node"))).toBeNull();
  expect(new URL(page.url()).searchParams.get("node")).toBe("agent-1");
  expect(new URL(tabB.url()).searchParams.get("node")).toBe("local");

  const serverLogsPathsA = requestsA.filter((url) => new URL(url).pathname.includes("serverLogs"));
  expect(serverLogsPathsA.length).toBeGreaterThan(0);
  expect(serverLogsPathsA.every((url) => new URL(url).pathname.startsWith("/api/n/agent-1/"))).toBe(
    true,
  );
  const serverLogsPathsB = requestsB.filter((url) => new URL(url).pathname.includes("serverLogs"));
  expect(serverLogsPathsB.length).toBeGreaterThan(0);
  expect(serverLogsPathsB.every((url) => new URL(url).pathname.startsWith("/api/n/local/"))).toBe(
    true,
  );

  const scanned: string[] = [await tabB.content(), await stopTab.content()];
  for (const pending of bodiesB) scanned.push(await pending);
  for (const pending of bodiesStop) scanned.push(await pending);
  const lowered = scanned.map((text) => text.toLowerCase());
  for (const sentinel of E2E_SENTINEL_VALUES) {
    const needle = sentinel.toLowerCase();
    for (const text of lowered) {
      expect(text).not.toContain(needle);
    }
  }

  await tabB.close();
  await stopTab.close();
});
