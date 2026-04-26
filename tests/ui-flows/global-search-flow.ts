// tests/ui-flows/global-search-flow.ts
import { PilotDriver } from './pilot-driver.js';

export async function runGlobalSearchFlow(pilot: PilotDriver) {
  // 1. App loads, verify search box
  await pilot.click('test-id=global-search-input');
  await pilot.type('qwen');

  // 2. Wait for results tree to appear
  await pilot.waitForSelector('test-id=global-search-results');

  // 3. Verify the workload match is visible
  await pilot.waitForSelector('test-id=search-parent-workload-qwen-72b');

  // 4. Click the result
  await pilot.click('test-id=search-parent-workload-qwen-72b');

  // 5. Verify the tab opened
  await pilot.waitForSelector('test-id=tab-label-workload:qwen-72b');

  // 6. Close the tab to leave the app clean for the next test
  await pilot.click('test-id=tab-close-workload:qwen-72b');
}