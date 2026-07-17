// Round 12: chimney smoke verification.
// Usage: node docs/scratch/shot-r12.mjs <label> <dragX> <dragY> [zoomSteps]
// Zooms at canvas center, then drags by (dragX, dragY) to pan.
import { chromium } from 'playwright';

const label = process.argv[2] ?? 'r12';
const dragX = Number(process.argv[3] ?? 0);
const dragY = Number(process.argv[4] ?? 0);
const zoomSteps = Number(process.argv[5] ?? 5);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://localhost:5173');
await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(6000);

const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

// Zoom in
await page.mouse.move(cx, cy);
for (let i = 0; i < zoomSteps; i++) {
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(200);
}

// Pan via drag (repeat to cover large distances)
const repeats = Number(process.argv[6] ?? 1);
for (let r = 0; r < repeats && (dragX !== 0 || dragY !== 0); r++) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dragX, cy + dragY, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

// Let smoke accumulate a few seconds
await page.waitForTimeout(5000);
await page.screenshot({ path: `docs/scratch/shots/${label}.png` });

// Print current clock
const txt = await page.locator('header, body').first().innerText();
const m = txt.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
console.log('clock:', m ? m[0] : 'not found');
await browser.close();
