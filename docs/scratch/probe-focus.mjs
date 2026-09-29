// Focus the camera on the first location of a type, zoom in, screenshot the canvas.
// Usage: node docs/scratch/probe-focus.mjs <locationType> [zoomSteps]  (verify server running)
import { chromium } from 'playwright';
const type = process.argv[2] ?? 'park', steps = Number(process.argv[3] ?? 3);
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5173/');
await page.waitForTimeout(8000);
const id = await page.evaluate(async (t) => {
  const { trpcClient } = await import('/src/lib/trpc.ts');
  const l = (await trpcClient.locations.getAll.query()).find(x => x.type === t);
  (await import('/src/lib/canvasBus.ts')).emitCanvasEvent({ type: 'focusLocation', locationId: l.id });
  return l.id;
}, type);
const box = await page.locator('canvas').first().boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.waitForTimeout(700);
for (let i = 0; i < steps; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -240); await page.waitForTimeout(150); }
await page.mouse.move(box.x + 5, box.y + 5);
await page.waitForTimeout(2500);
await page.screenshot({ path: `docs/scratch/shots/focus-${type}.png`, clip: box });
console.log(type, id, 'errors:', errors.slice(0, 5));
await browser.close();
