// Screenshot the World Layout wizard step, which now reports the dimensions
// actually generated (and flags when the pipeline grew past the tier preset).
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173');
await page.waitForTimeout(3000);
await page.locator('button', { hasText: /^Balanced/ }).click().catch(() => {});
await page.waitForTimeout(500);

for (let i = 0; i < 12; i++) {
  if (await page.locator('h2', { hasText: 'World Layout' }).count()) break;
  const next = page.locator('button', { hasText: /^Next$/ }).first();
  if (!(await next.count()) || !(await next.isEnabled())) break;
  await next.click();
  await page.waitForTimeout(1200);
}

await page.waitForTimeout(2500);
console.log('generated line:',
  await page.locator('text=/Generated:/').first().textContent().catch(() => 'NOT FOUND'));

await page.screenshot({ path: 'docs/scratch/shots/worldlayout-auto.png' });

// Switch to the Medium tier so the preset-vs-actual comparison is exercised.
await page.locator('select').first().selectOption('medium');
await page.waitForTimeout(2500);
console.log('medium:',
  await page.locator('text=/Generated:/').first().textContent().catch(() => 'NOT FOUND'));
await page.screenshot({ path: 'docs/scratch/shots/worldlayout-medium.png' });

await browser.close();
