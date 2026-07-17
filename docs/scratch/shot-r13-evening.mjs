// Round 13: wait for evening (>=5 PM), then screenshot home cluster for chimney smoke.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://localhost:5173');
await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(5000);

// Speed up to 4x while waiting
const btn = page.locator('button', { hasText: '4x' }).first();
if (await btn.count()) await btn.click().catch(() => {});

// Poll clock until >= 17:00
const deadline = Date.now() + 10 * 60 * 1000;
let hour24 = -1;
while (Date.now() < deadline) {
  const txt = await page.locator('header, body').first().innerText();
  const m = txt.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3].toUpperCase() === 'PM') h += 12;
    hour24 = h;
    console.log('clock:', m[0]);
    if (h >= 17 && h < 23) break;
  }
  await page.waitForTimeout(8000);
}

// Back to 1x for stable capture
const btn1 = page.locator('button', { hasText: '1x' }).first();
if (await btn1.count()) await btn1.click().catch(() => {});

const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

// Wide evening shot first
await page.waitForTimeout(3000);
await page.screenshot({ path: 'docs/scratch/shots/r13-evening-wide.png' });

// Zoom toward home cluster top-right (homes at world ~1344-1664, y 288)
await page.mouse.move(cx, cy);
for (let i = 0; i < 5; i++) {
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(200);
}
// Pan: homes are up-right of center → drag content down-left
for (let r = 0; r < 2; r++) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 450, cy + 450, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}
await page.waitForTimeout(5000);
await page.screenshot({ path: 'docs/scratch/shots/r13-evening-homes.png' });
console.log('done, hour24=', hour24);
await browser.close();
