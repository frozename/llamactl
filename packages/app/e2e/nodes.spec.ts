// packages/app/e2e/nodes.spec.ts — #410 P5b part 2a.
// The nodes view: default badge only on local, kinds from the fixture
// kubeconfig, a blank-target endpoint link for agent-1, no rag
// credentials in the ragdb row, the dispatchable tab-node options and
// the control-driven reachability flip proven across a full reload
// (nodeTest polls every 30 s, so SPA nav would not re-read it in time).

import { expect, test } from "./harness/fixtures/test";

test("rows carry kinds, the default badge and safe endpoints", async ({ page }) => {
  await page.goto("/nodes");
  const local = page.getByTestId("console-node-row-local");
  await expect(local).toBeVisible();
  await expect(local).toContainText("default");
  for (const name of ["agent-1", "agent-off", "gw-1", "ragdb"]) {
    await expect(page.getByTestId(`console-node-row-${name}`)).not.toContainText("default");
  }
  await expect(page.getByTestId("console-node-row-agent-1").locator("span").nth(1)).toHaveText(
    "agent",
  );
  await expect(page.getByTestId("console-node-row-gw-1").locator("span").nth(1)).toHaveText(
    "gateway",
  );
  await expect(page.getByTestId("console-node-row-ragdb").locator("span").nth(1)).toHaveText("rag");
  await expect(
    page.getByTestId("console-node-row-agent-1").locator('a[target="_blank"]'),
  ).toHaveAttribute("href", "https://agent-1.fixture:8443");
  const ragRow = page.getByTestId("console-node-row-ragdb");
  await expect(ragRow).not.toContainText("sentinel-pg");
  await expect(ragRow).not.toContainText("postgres://");
  await expect(page.getByLabel("Tab node").locator("option")).toHaveText([
    "local",
    "agent-1",
    "agent-off",
  ]);
});

test("a reachability flip is picked up on reload", async ({ control, page }) => {
  await page.goto("/nodes");
  const agentOff = page.getByTestId("console-node-row-agent-off");
  const agentOne = page.getByTestId("console-node-row-agent-1");
  await expect(agentOff).toContainText("unreachable: e2e node unreachable");
  await expect(agentOne.getByText("reachable", { exact: true })).toBeVisible();
  await control.setReachable("agent-off", true);
  await control.setReachable("agent-1", false);
  await page.reload();
  await expect(agentOff.getByText("reachable", { exact: true })).toBeVisible();
  await expect(agentOne).toContainText("unreachable: e2e node unreachable");
});
