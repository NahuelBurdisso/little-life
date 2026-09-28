// Round 17: pausing must not collapse feed timestamps to "0m ago" (HIGH-1)
// and must not reset the chosen speed back to 1x (LOW-5).
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173');
await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(4000);
await page.locator('button', { hasText: /^4x$/ }).click().catch(() => {});

const rows = page.locator('button[aria-label$="focus agent"]');
for (let i = 0; i < 20 && (await rows.count()) === 0; i++) await page.waitForTimeout(10000);
if ((await rows.count()) === 0) { console.log('NO ROWS'); await browser.close(); process.exit(1); }

const labelsBefore = await rows.evaluateAll((els) => els.slice(0, 4).map((e) => e.getAttribute('aria-label')));
console.log('running:', labelsBefore);

// Pause with Space
await page.keyboard.press('Space');
await page.waitForTimeout(1500);
const labelsPaused = await rows.evaluateAll((els) => els.slice(0, 4).map((e) => e.getAttribute('aria-label')));
console.log('paused: ', labelsPaused);
const allZero = labelsPaused.length > 1 && labelsPaused.every((l) => l.startsWith('0m ago'));
console.log('all "0m ago" while paused (expect false):', allZero);

// Speed highlight must still be 4x while paused, and resume must keep it
const speedActive = () =>
  page.locator('button', { hasText: /^(0.5x|1x|2x|4x)$/ })
    .evaluateAll((els) => els.filter((e) => !e.className.includes('opacity')).map((e) => `${e.textContent}:${e.className.slice(0, 40)}`));
console.log('speed buttons while paused:', await speedActive());

await page.keyboard.press('Space');
await page.waitForTimeout(1500);
const tickSpeed = await page.evaluate(async () => {
  const el = document.body.innerText.match(/tick:(\d+)/);
  return el ? el[1] : 'n/a';
});
console.log('tick after resume:', tickSpeed);
await page.screenshot({ path: 'docs/scratch/shots/r17-after-resume.png' });

await browser.close();
