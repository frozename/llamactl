// packages/app/e2e/lifecycle.spec.ts — #410 P5b part 2b.
// The workload stop lifecycle on agent-1: cancel leaves zero
// mutations, the typed-name gate keeps the submit disabled, the three
// fixture stop modes (success toast + close, inline refusal, inline
// error) each fire exactly one serverStop with no retry, the multi-node
// row is disabled with the worker reason while a foreign-node row is
// not offered at all, and forged stops are refused by the allowlist
// precheck with a 409 before the backend records anything.

import type { Locator, Page } from "@playwright/test";

import type { ControlClient, RecordedCall } from "./harness/fixtures/test";

import { E2E_PID, E2E_SENTINEL_VALUES } from "./harness/fixtures/seed";
import { expect, test } from "./harness/fixtures/test";

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };
const STOP_PATH = "/api/n/agent-1/trpc/serverStop";
const WORKLOADS_ROUTE = "/workloads?node=agent-1";

async function openStopDialog(page: Page): Promise<Locator> {
  await page.getByTestId("console-workload-row-wB").getByRole("button", { name: "Stop" }).click();
  const dialog = page.getByRole("dialog", { name: "Stop wB" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("role", "dialog");
  return dialog;
}

async function stopCalls(control: ControlClient, node: string): Promise<RecordedCall[]> {
  return (await control.calls(node)).filter((call) => call.procedure === "serverStop");
}

test("canceling the dialog records zero stop mutations", async ({ control, page }) => {
  await page.goto(WORKLOADS_ROUTE);
  const dialog = await openStopDialog(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await stopCalls(control, "agent-1")).toEqual([]);
  expect(await stopCalls(control, "local")).toEqual([]);
});

test("the Stop submit stays gated until the typed name matches", async ({ control, page }) => {
  await page.goto(WORKLOADS_ROUTE);
  const dialog = await openStopDialog(page);
  const submit = dialog.getByRole("button", { name: "Stop" });
  const confirm = dialog.getByRole("textbox");
  await expect(submit).toBeDisabled();
  await confirm.fill("wb");
  await expect(submit).toBeDisabled();
  await confirm.fill("wB-x");
  await expect(submit).toBeDisabled();
  await confirm.fill("wB");
  await expect(submit).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await stopCalls(control, "agent-1")).toEqual([]);
});

test("ok mode stops once on the tab node and toasts the pid", async ({ control, page }) => {
  await page.goto(WORKLOADS_ROUTE);
  await control.setServerStopMode("ok");
  const dialog = await openStopDialog(page);
  await dialog.getByRole("textbox").fill("wB");
  await dialog.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("status")).toContainText(
    `Stopped llama-server (PID ${String(E2E_PID)})`,
  );
  await expect(dialog).toBeHidden();
  expect(await stopCalls(control, "agent-1")).toEqual([
    { input: { graceSeconds: 5, workload: "wB" }, node: "agent-1", procedure: "serverStop" },
  ]);
  expect(await stopCalls(control, "local")).toEqual([]);
});

test("not-stopped mode shows an inline refusal and never retries", async ({ control, page }) => {
  await page.goto(WORKLOADS_ROUTE);
  await control.setServerStopMode("not-stopped");
  const dialog = await openStopDialog(page);
  await dialog.getByRole("textbox").fill("wB");
  await dialog.getByRole("button", { name: "Stop" }).click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("Stop not confirmed");
  await expect(alert).toContainText(`PID ${String(E2E_PID)}`);
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(await stopCalls(control, "agent-1")).toHaveLength(1);
});

test("throw mode shows an inline error and never retries", async ({ control, page }) => {
  await page.goto(WORKLOADS_ROUTE);
  await control.setServerStopMode("throw");
  const dialog = await openStopDialog(page);
  await dialog.getByRole("textbox").fill("wB");
  await dialog.getByRole("button", { name: "Stop" }).click();
  await expect(dialog.getByRole("alert")).toContainText("fixture_server_stop_failed");
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(await stopCalls(control, "agent-1")).toHaveLength(1);
});

test("the multi-node row is disabled with the worker reason", async ({ page }) => {
  await page.goto(WORKLOADS_ROUTE);
  const row = page.getByTestId("console-workload-row-wMulti");
  await expect(row.getByRole("button", { name: "Stop" })).toBeDisabled();
  await expect(row).toContainText("rpc-server running on local");
  await expect(
    page.getByTestId("console-workload-row-wA").getByRole("button", { name: "Stop" }),
  ).toHaveCount(0);
});

test("forged stops are refused before the backend", async ({ control, page }) => {
  await page.goto("/");
  const mismatch = await page.request.post(STOP_PATH, {
    data: { graceSeconds: 5, workload: "wA" },
    headers: SAME_ORIGIN,
  });
  expect(mismatch.status()).toBe(409);
  const mismatchBody = await mismatch.text();
  expect(mismatchBody).toContain("workload_node_mismatch");
  const multi = await page.request.post(STOP_PATH, {
    data: { graceSeconds: 5, workload: "wMulti" },
    headers: SAME_ORIGIN,
  });
  expect(multi.status()).toBe(409);
  const multiBody = await multi.text();
  expect(multiBody).toContain("multi_node_workload");
  for (const body of [mismatchBody, multiBody]) {
    for (const sentinel of E2E_SENTINEL_VALUES) {
      expect(body).not.toContain(sentinel);
    }
  }
  expect(await stopCalls(control, "agent-1")).toEqual([]);
  expect(await stopCalls(control, "local")).toEqual([]);
});
