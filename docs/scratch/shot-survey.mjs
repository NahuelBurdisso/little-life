// Quick three-zoom survey of the map at whatever the sim clock currently is.
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
const cx = b.x + b.width / 2;
const cy = b.y + b.height / 2;
const clip = { x: b.x, y: b.y, width: b.width, height: b.height };

await page.mouse.move(cx, cy);
for (let z = 0; z < 14; z++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(60); }
await page.waitForTimeout(1200);
await page.screenshot({ path: 'docs/scratch/shots/survey-wide.png', clip });

for (let z = 0; z < 5; z++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(60); }
await page.waitForTimeout(1200);
await page.screenshot({ path: 'docs/scratch/shots/survey-mid.png', clip });

for (let z = 0; z < 5; z++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(60); }
await page.waitForTimeout(1200);
await page.screenshot({
  path: 'docs/scratch/shots/survey-close.png',
  clip: { x: cx - 400, y: cy - 280, width: 800, height: 560 },
});

await browser.close();
console.log('done');
