// Screenshot the World Layout step with a seed the generator cannot fully fill,
// so the non-fatal warning line is exercised.
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

const seedInput = page.locator('input').first();
const warn = page.locator('text=/Regenerate for a different town/');
let hit = null;
for (const s of ['W0', 'W1', 'W6', 'W2', 'W3', 'W4', 'W5', 'W7', 'W8', 'W9']) {
  await seedInput.fill(s);
  await page.waitForTimeout(2000);
  const texts = await warn.allTextContents();
  if (texts.length) { hit = { s, texts }; break; }
}
console.log('hit:', JSON.stringify(hit));
await page.screenshot({ path: 'docs/scratch/shots/worldlayout-warning.png' });

await browser.close();
