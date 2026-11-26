// packages/app/e2e/fleet.spec.ts — #410 P5b part 2a.
// The fleet view on the default tab node: every fixture node renders,
// reachability lands on the seed's unreachable set, the new-tab deep
// link opens a second tab pinned to agent-1, exposed endpoints are
// blank-target, and the tab-node card renders masked secrets as "set".

import { E2E_SERVER_STATUS } from "./harness/fixtures/seed";
import { expect, test } from "./harness/fixtures/test";

test("the landing dashboard summarizes agent reachability and links to detail", async ({
  page,
}) => {
  await page.goto("/");
  const dashboard = page.getByTestId("console-view-dashboard");
  await expect(dashboard.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(dashboard.getByRole("status")).toHaveText("Attention needed");
  await expect(dashboard.getByText("2 / 3", { exact: true })).toBeVisible();
  await expect(dashboard.getByRole("link", { name: "Fleet Stats" })).toHaveAttribute(
    "href",
    "/stats?node=local",
  );
});

test("every fixture node renders its fleet tile", async ({ page }) => {
  await page.goto("/fleet");
  for (const name of ["local", "agent-1", "agent-off", "gw-1", "ragdb"]) {
    await expect(page.getByTestId(`console-fleet-node-${name}`)).toBeVisible();
  }
});

test("reachability reflects the seeded unreachable node", async ({ page }) => {
  await page.goto("/fleet");
  await expect(page.getByTestId("console-fleet-node-agent-off")).toContainText(
    "unreachable: e2e node unreachable",
  );
  await expect(
    page.getByTestId("console-fleet-node-local").getByText("reachable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId("console-fleet-node-agent-1").getByText("reachable", { exact: true }),
  ).toBeVisible();
});

test("the new-tab link opens a second tab bound to agent-1", async ({ page }) => {
  await page.goto("/fleet");
  const link = page.getByRole("link", { name: "Open in new tab on agent-1" });
  await expect(link).toHaveAttribute("target", "_blank");
  const rel = await link.getAttribute("rel");
  expect(rel ?? "").toContain("noopener");
  const [newTab] = await Promise.all([page.context().waitForEvent("page"), link.click()]);
  await newTab.waitForURL("**/fleet?node=agent-1");
  expect(newTab.url()).toContain("?node=agent-1");
  await expect(newTab.getByLabel("Tab node")).toHaveValue("agent-1");
  await newTab.close();
});

test("exposed workload endpoints open in new tabs", async ({ page }) => {
  await page.goto("/fleet");
  const exposed = page.getByTestId("console-fleet-exposed");
  await expect(exposed.locator("a")).toHaveCount(3);
  for (const workload of ["wA", "wB", "wMulti"] as const) {
    const endpoint = E2E_SERVER_STATUS[workload]?.advertisedEndpoint ?? "";
    await expect(exposed.locator(`a[href="${endpoint}"][target="_blank"]`)).toHaveCount(1);
  }
});

test("the tab-node card renders masked env secrets as set", async ({ page }) => {
  await page.goto("/fleet");
  const card = page.getByTestId("console-fleet-tab-node");
  for (const key of ["LM_API_TOKEN", "OPENAI_API_KEY"]) {
    const row = card.locator("div").filter({ hasText: key });
    await expect(row).toHaveCount(1);
    await expect(row.locator("span").nth(1)).toHaveText("set");
  }
});
