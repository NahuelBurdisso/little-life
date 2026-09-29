// Probe for the Aseprite agent sheets: zoom in close, run at 4x, capture a burst, and report
// which sheet PNGs loaded plus any console errors.
// Usage: node docs/scratch/shot-agent-sheets.mjs [zoomSteps] [zoomAtX] [zoomAtY]
//   zoomAt = page coords of the spot to inspect: it is dragged to the canvas centre first,
//   because the wheel zooms about the centre, not the cursor. 0 0 = leave the camera alone.
//   zoomSteps 0 = one wide shot only, to find agents.
import { chromium } from 'playwright';

const zoomSteps = Number(process.argv[2] ?? 8);
const atX = Number(process.argv[3] ?? 0);
const atY = Number(process.argv[4] ?? 0);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
const sheets = new Set();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', r => { if (r.url().includes('_sheet.png')) sheets.add(`${r.status()} ${r.url().split('/').pop()}`); });
await page.goto('http://localhost:5173');
await page.waitForTimeout(9000);

const box = await page.locator('canvas').first().boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
if (zoomSteps === 0) {
  await page.screenshot({ path: 'docs/scratch/shots/sheet-wide.png' });
  await browser.close();
  process.exit(0);
}
if (atX || atY) {
  await page.mouse.move(atX, atY); await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 15 }); await page.mouse.up();
  await page.waitForTimeout(300);
}
for (let i = 0; i < zoomSteps; i++) {
  await page.mouse.move(cx, cy); await page.mouse.wheel(0, -240); await page.waitForTimeout(150);
}
if (process.env.HOVER) {
  const [hx, hy] = process.env.HOVER.split(',').map(Number);  // page coords after zoom
  await page.mouse.move(hx, hy);
} else {
  await page.getByText('4x', { exact: true }).click().catch(() => {});
}
const BURST = Number(process.env.BURST ?? 6), GAP = Number(process.env.GAP ?? 700);
for (let i = 0; i < BURST; i++) {
  await page.waitForTimeout(GAP);
  await page.screenshot({ path: `docs/scratch/shots/sheet-${i}.png`, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
}
await page.getByText('1x', { exact: true }).click().catch(() => {});
console.log('sheets:', [...sheets].sort().join(', '));
console.log('errors:', errors.slice(0, 5));
await browser.close();
