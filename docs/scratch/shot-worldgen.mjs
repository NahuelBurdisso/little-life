import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto('http://localhost:5173');
await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(6000);

// Zoom out to frame the whole town.
const box = await page.locator('canvas').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
for (let i = 0; i < 9; i++) {
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(150);
}
await page.waitForTimeout(2500);
await page.screenshot({ path: 'docs/scratch/shots/worldgen-after.png' });
console.log('shot saved');
await browser.close();
