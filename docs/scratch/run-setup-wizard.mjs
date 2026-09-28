// Drive the setup wizard to completion with defaults so the dev world is
// playable again after a `db:reset` (which leaves setup_config NULL).
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173');
await page.waitForTimeout(3000);

await page.locator('button', { hasText: /^Balanced/ }).click().catch(() => {});
await page.waitForTimeout(500);

for (let i = 0; i < 12; i++) {
  const start = page.locator('button', { hasText: /^(Start|Begin|Create|Launch|Finish)/ }).first();
  if (await start.count()) {
    console.log('clicking final:', (await start.textContent())?.trim());
    await start.click();
    break;
  }
  const next = page.locator('button', { hasText: /^Next$/ }).first();
  if (!(await next.count()) || !(await next.isEnabled())) break;
  await next.click();
  await page.waitForTimeout(1200);
}

await page.waitForSelector('canvas', { timeout: 120000 });
console.log('canvas up');
await page.waitForTimeout(3000);
await page.screenshot({ path: 'docs/scratch/shots/setup-done.png' });
await browser.close();
