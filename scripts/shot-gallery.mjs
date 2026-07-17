// Screenshot gallery: day close-ups + speed to 4x, then night shot.
// Usage: node scripts/shot-gallery.mjs [phase]  phase = day | night
import { chromium } from 'playwright';

const phase = process.argv[2] || 'day';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:5173');
await page.waitForTimeout(10000);

const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

async function zoomIn(steps) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(200);
  }
}
async function drag(dx, dy) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

if (phase === 'day') {
  await page.screenshot({ path: 'docs/scratch/shots/g-day-wide.png' });
  await zoomIn(5);
  await page.screenshot({ path: 'docs/scratch/shots/g-day-zoom-center.png' });
  await drag(600, 200); // pan west/up-ish
  await page.screenshot({ path: 'docs/scratch/shots/g-day-zoom-a.png' });
  await drag(-1100, -300); // pan east
  await page.screenshot({ path: 'docs/scratch/shots/g-day-zoom-b.png' });
  await drag(0, 500); // pan north part
  await page.screenshot({ path: 'docs/scratch/shots/g-day-zoom-c.png' });
  // set speed 4x for night run
  await page.getByText('4x', { exact: true }).click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'docs/scratch/shots/g-day-final.png' });
} else {
  await page.screenshot({ path: 'docs/scratch/shots/g-night-wide.png' });
  await zoomIn(5);
  await page.screenshot({ path: 'docs/scratch/shots/g-night-zoom-center.png' });
  await drag(600, 200);
  await page.screenshot({ path: 'docs/scratch/shots/g-night-zoom-a.png' });
  await drag(-1100, -300);
  await page.screenshot({ path: 'docs/scratch/shots/g-night-zoom-b.png' });
}

await browser.close();
console.log('done', phase);
