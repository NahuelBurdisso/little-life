import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text()); });
await page.goto('http://localhost:5173');
await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(5000);
await page.locator('button', { hasText: /^4x$/ }).click().catch(() => {});
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(15000);
  const n = await page.locator('button[aria-label$="focus agent"]').count();
  const tick = (await page.locator('body').innerText()).match(/tick:(\d+)/);
  console.log(`t+${(i + 1) * 15}s tick=${tick?.[1]} clickableRows=${n}`);
  if (n > 0) break;
}
const labels = await page.locator('button[aria-label$="focus agent"]').evaluateAll(ns => ns.map(n => n.getAttribute('aria-label')));
console.log(labels.slice(0, 8));
await browser.close();
