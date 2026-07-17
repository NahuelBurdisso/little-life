// Poll sim clock until night (>=9 PM or <5 AM), then capture night shots.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:5173');
await page.waitForTimeout(8000);

function isNight(text) {
  const m = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return false;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return h >= 21 || h < 5;
}

const deadline = Date.now() + 12 * 60 * 1000;
let clock = '';
while (Date.now() < deadline) {
  clock = await page.locator('header, body').first().innerText().catch(() => '');
  const line = clock.split('\n').find(l => /AM|PM/.test(l)) || '';
  if (isNight(line)) break;
  await page.waitForTimeout(10000);
}
console.log('clock line:', (clock.split('\n').find(l => /AM|PM/.test(l)) || 'unknown'));

await page.screenshot({ path: 'docs/scratch/shots/g-night-wide.png' });
const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
for (let i = 0; i < 12; i++) {
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(150);
}
await page.screenshot({ path: 'docs/scratch/shots/g-night-zoom.png' });
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx - 700, cy - 200, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(400);
await page.screenshot({ path: 'docs/scratch/shots/g-night-zoom-b.png' });
await browser.close();
console.log('done night');
