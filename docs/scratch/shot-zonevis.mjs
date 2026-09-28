// Visual check for the zone/furniture/door fixes: focus an agent via the feed,
// zoom in, hover the building under the cursor to fade its interior in, and
// capture a tight crop around the canvas centre.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text()); });

await page.goto('http://localhost:5173');
await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(6000);

const rows = page.locator('button[aria-label$="focus agent"]');
for (let i = 0; i < 12 && (await rows.count()) < 1; i++) await page.waitForTimeout(5000);
console.log('feed rows:', await rows.count());

const canvas = page.locator('canvas').first();
const b = await canvas.boundingBox();
const cx = b.x + b.width / 2;
const cy = b.y + b.height / 2;

const shots = Number(process.env.SHOTS ?? 4);
for (let i = 0; i < shots; i++) {
  await page.mouse.move(cx, cy);
  for (let z = 0; z < 12; z++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(80); }
  // Focus AFTER zooming: zoom-toward-cursor shifts the camera, so focusing first
  // left the subject off-crop.
  if (await rows.count() > i) {
    await rows.nth(i).click();
    await page.waitForTimeout(2000);
  }
  // Jiggle so the hover hit-test fires and the interior fades in.
  await page.mouse.move(cx + 2, cy + 2);
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: `docs/scratch/shots/zonevis-${i}.png`,
    clip: { x: cx - 320, y: cy - 200, width: 640, height: 400 },
  });
  for (let z = 0; z < 12; z++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(60); }
  await page.waitForTimeout(400);
}

await browser.close();
console.log('done');
