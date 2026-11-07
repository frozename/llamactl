// packages/app/e2e/restart.spec.ts — #410 T6.
// Restart recovery against the harness /restart-console control route:
// the console rebinds the same port with a fresh session nonce while
// the fixture backend survives. Query paths surface the invalid-session
// banner on the stale cookie and recover on reload; the logs path is
// proven to re-subscribe after reload (a fresh open stream + a
// control-emitted marker). No banner assertion on the SSE path:
// EventSource cannot observe the 401, so the session rules do not
// cover it.

import type { ControlClient } from "./harness/fixtures/test";

import { E2E_CONSOLE_PORT } from "./harness/fixtures/seed";
import { expect, test } from "./harness/fixtures/test";

const COOKIE_NAME = `llamactl_console_${String(E2E_CONSOLE_PORT)}`;
const INVALID_SESSION_MESSAGE = "Console restarted or session expired — reload";
const LOGS_ROUTE = "/logs/wB?node=agent-1";

async function pollOpenWbStream(control: ControlClient, open: boolean): Promise<void> {
  await expect
    .poll(
      async () =>
        (await control.streams("agent-1")).filter((entry) => entry.workload === "wB").length > 0,
      { timeout: 5_000 },
    )
    .toBe(open);
}

test("a query fetch after restart shows the banner and reload restores the view", async ({
  control,
  page,
}) => {
  await page.goto("/workloads?node=agent-1");
  const row = page.getByTestId("console-workload-row-wB");
  await expect(row).toContainText("Running");

  const cookies = await page.context().cookies();
  expect(cookies).toHaveLength(1);
  expect(cookies[0]?.name).toBe(COOKIE_NAME);
  const oldCookie = cookies[0]?.value ?? "";
  expect(oldCookie).not.toBe("");

  await control.restartConsole();

  await row.getByRole("button", { name: "Describe" }).click();
  await expect(page.getByRole("alert")).toHaveText(INVALID_SESSION_MESSAGE);

  await page.reload();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(row).toContainText("Running");
  await row.getByRole("button", { name: "Describe" }).click();
  await expect(row.locator("pre").first()).toContainText("name: wB");

  const after = await page.context().cookies();
  expect(after).toHaveLength(1);
  expect(after[0]?.value).not.toBe(oldCookie);
});

test("the logs tail re-subscribes on reload after a restart", async ({ control, page }) => {
  await page.goto(LOGS_ROUTE);
  const conn = page.getByTestId("console-logs-conn");
  await expect(conn).toHaveAttribute("data-state", "streaming", { timeout: 5_000 });
  await pollOpenWbStream(control, true);

  await control.restartConsole();

  // server.stop may not abort the old fixture generator, so retire the
  // stale stream deterministically before reloading.
  await control.dropStream("agent-1", "wB");
  await expect
    .poll(
      async () =>
        (await control.streams("agent-1")).filter((entry) => entry.workload === "wB").length,
      { timeout: 5_000 },
    )
    .toBe(0);

  await page.reload();
  await expect(conn).toHaveAttribute("data-state", "streaming", { timeout: 5_000 });
  await pollOpenWbStream(control, true);

  await control.emitLog("agent-1", "wB", "restart-recovery-marker");
  await expect(
    page.getByTestId("console-logs-line").filter({ hasText: "restart-recovery-marker" }),
  ).toBeVisible();
});
