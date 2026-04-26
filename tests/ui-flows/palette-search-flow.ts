// tests/ui-flows/palette-search-flow.ts
import { PilotDriver } from './pilot-driver.js';

export async function runPaletteSearchFlow(pilot: PilotDriver) {
  // 1. Press Cmd+K (using pilot keyboard abstraction if available, else click a mock button or use keypress)
  // PilotDriver has a raw puppeteer/playwright page instance usually under `pilot.page`
  await pilot.page.keyboard.down('Meta');
  await pilot.page.keyboard.press('k');
  await pilot.page.keyboard.up('Meta');

  // 2. Wait for palette
  await pilot.waitForSelector('test-id=command-palette');

  // 3. Type a module name that should match via alias or directly
  await pilot.type('logs');

  // 4. Wait for the list to update and verify the first item is selected
  await pilot.waitForSelector('test-id=command-palette-results');

  // 5. Press Enter to activate
  await pilot.page.keyboard.press('Enter');

  // 6. Verify the module tab opened
  await pilot.waitForSelector('test-id=tab-label-module:logs');

  // 7. Close the tab
  await pilot.click('test-id=tab-close-module:logs');
}