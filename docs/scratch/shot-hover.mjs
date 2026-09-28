// Verify the building hover card + interior fade fire on pointerover.
// Sweeps the cursor across the canvas and screenshots wherever a card appears.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text()); });

await page.goto('http://localhost:5173');
await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(6000);
await page.keyboard.press('Escape');

const canvas = page.locator('canvas').first();
const b = await canvas.boundingBox();
const clip = { x: b.x, y: b.y, width: b.width, height: b.height };
const cx = b.x + b.width / 2;
const cy = b.y + b.height / 2;

// Zoom to a level where several buildings share the screen.
await page.mouse.move(cx, cy);
for (let z = 0; z < 8; z++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(60); }
for (let z = 0; z < 3; z++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(60); }
await page.waitForTimeout(1500);

let n = 0;
for (const [fx, fy] of [[0.3, 0.3], [0.5, 0.3], [0.7, 0.35], [0.3, 0.6], [0.5, 0.55], [0.72, 0.62], [0.4, 0.8]]) {
  const px = b.x + b.width * fx;
  const py = b.y + b.height * fy;
  await page.mouse.move(px - 30, py - 30);
  await page.waitForTimeout(200);
  await page.mouse.move(px, py);
  await page.waitForTimeout(700);
  await page.screenshot({
    path: `docs/scratch/shots/hover-${n++}.png`,
    clip: { x: px - 260, y: py - 200, width: 520, height: 360 },
  });
}

await browser.close();
console.log('done');
