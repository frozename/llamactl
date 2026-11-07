// packages/app/e2e/workloads.spec.ts — #410 P5b part 2a.
// The workloads view scoped to agent-1: rows + other-nodes footer, the
// describe drawer's argv masking, the workers panel, deep links (open
// drawer here, switch-link notice with zero backend calls there) and
// the no-reconciler / stop-inside-row toolbar contract.

import { E2E_SENTINELS, E2E_SERVER_STATUS } from "./harness/fixtures/seed";
import { expect, test } from "./harness/fixtures/test";

function isInputRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

test("row phases, the endpoint link and the liveStatus drawer agree for wB (#410 T2)", async ({
  page,
}) => {
  await page.goto("/workloads?node=agent-1");
  const row = page.getByTestId("console-workload-row-wB");
  await expect(row).toContainText("Running");
  await expect(page.getByTestId("console-workload-row-wB-stopped")).toContainText("Stopped");
  const endpoint = E2E_SERVER_STATUS["wB"]?.advertisedEndpoint ?? "";
  expect(endpoint).toBe("http://127.0.0.1:8082");
  await expect(row.getByRole("link", { name: endpoint })).toHaveAttribute("href", endpoint);
  await row.getByRole("button", { name: "Describe" }).click();
  const liveStatus = row.locator("pre").nth(1);
  await expect(liveStatus).toContainText(`"advertisedEndpoint": "${endpoint}"`);
  await expect(liveStatus).toContainText(`"state": "up"`);
});

test("rows are scoped to the tab node with an other-nodes footer", async ({ page }) => {
  await page.goto("/workloads?node=agent-1");
  for (const name of ["wB", "wB-stopped", "wMulti"]) {
    await expect(page.getByTestId(`console-workload-row-${name}`)).toBeVisible();
  }
  await expect(page.getByTestId("console-workload-row-wA")).toHaveCount(0);
  await expect(page.getByTestId("console-workloads-other-nodes")).toContainText("local · 1");
});

test("the describe drawer masks argv secrets", async ({ page }) => {
  await page.goto("/workloads?node=agent-1");
  const row = page.getByTestId("console-workload-row-wB");
  await row.getByRole("button", { name: "Describe" }).click();
  await expect(row).toContainText("--api-key");
  await expect(row).toContainText("[redacted]");
  await expect(row).not.toContainText(E2E_SENTINELS.arg);
  await expect(row).not.toContainText(E2E_SENTINELS.hf);
});

test("the describe drawer renders the workers panel", async ({ page }) => {
  await page.goto("/workloads?node=agent-1");
  const row = page.getByTestId("console-workload-row-wMulti");
  await row.getByRole("button", { name: "Describe" }).click();
  const panel = row.getByTestId("workloads-workers-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("local");
});

test("a deep link on the owning node opens the drawer on load", async ({ page }) => {
  await page.goto("/workloads/wB?node=agent-1");
  const row = page.getByTestId("console-workload-row-wB");
  await expect(row.getByRole("button", { name: "Hide" })).toBeVisible();
});

test("a deep link on the wrong node offers a switch link and calls no backend", async ({
  control,
  page,
}) => {
  await page.goto("/workloads/wA?node=agent-1");
  await expect(
    page.getByText("This workload runs on local. Switch this tab or open a new one"),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open wA on local" })).toBeVisible();
  expect(await control.calls("local")).toEqual([]);
  const offenders = (await control.calls("agent-1")).filter((call) => {
    const input: unknown = call.input;
    if (!isInputRecord(input)) return false;
    return input["name"] === "wA" || input["workload"] === "wA";
  });
  expect(offenders).toEqual([]);
});

test("no reconciler buttons and every stop button sits inside a row", async ({ page }) => {
  await page.goto("/workloads?node=agent-1");
  await expect(page.getByTestId("console-view-workloads")).toBeVisible();
  await expect(page.getByRole("button", { name: /apply/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^start/i })).toHaveCount(0);
  const pageWide = await page.getByRole("button", { name: "Stop" }).count();
  const withinRows = await page
    .locator('[data-testid^="console-workload-row-"]')
    .getByRole("button", { name: "Stop" })
    .count();
  expect(pageWide).toBeGreaterThan(0);
  expect(withinRows).toBe(pageWide);
});
