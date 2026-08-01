// Zoom in on the derived open areas (market square, farmyard, back alley) to
// check their props. Zoom-toward-cursor keeps the point under the mouse fixed,
// so parking the cursor on a target and wheeling in frames it.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173');
await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(6000);
await page.keyboard.press('Escape');

const canvas = page.locator('canvas').first();
const b = await canvas.boundingBox();
const cx = b.x + b.width / 2;
const cy = b.y + b.height / 2;

// Fully zoomed out first, so the page coords below always mean the same thing.
await page.mouse.move(cx, cy);
for (let z = 0; z < 14; z++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(50); }
await page.waitForTimeout(1000);

// Page coords of each target at full zoom-out, read off survey-wide.png.
// World-pixel -> page coords at full zoom-out. Measured off the live canvas box
// rather than hardcoded: the activity feed panel takes a chunk of the window, so
// the canvas is narrower than the viewport and any fixed offset is wrong.
const MAP_W = 1984, MAP_H = 1536;
const S = Math.min(b.width / MAP_W, b.height / MAP_H);
const OX = b.x + (b.width - MAP_W * S) / 2;
const OY = b.y + (b.height - MAP_H * S) / 2;
const world = (wx, wy) => [Math.round(OX + wx * S), Math.round(OY + wy * S)];
const targets = {
  market: world(640 + 64, 288 + 64),
  farmyard: world(384 + 48, 768 + 48),
  alley: world(1280 + 64, 704 + 16),
  townsquare: world(736 + 144, 608 + 128),
};

for (const [name, [px, py]] of Object.entries(targets)) {
  // Back to full out between targets. Escape first: a side panel opening
  // resizes the canvas and invalidates every page coordinate below.
  await page.keyboard.press('Escape');
  await page.mouse.move(cx, cy);
  for (let z = 0; z < 14; z++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(40); }
  await page.waitForTimeout(600);

  await page.mouse.move(px, py);
  for (let z = 0; z < 7; z++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(60); }
  await page.waitForTimeout(1200);
  await page.screenshot({
    path: `docs/scratch/shots/props-${name}.png`,
    clip: { x: Math.max(0, px - 350), y: Math.max(0, py - 250), width: 700, height: 500 },
  });
}

await browser.close();
console.log('done');
