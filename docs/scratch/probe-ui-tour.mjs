// Full-window tour of the UI after the feedback pass: main view, a building's LocationPanel,
// the event menu, the autoplay panel, and an agent panel. Verify server must be running.
// Usage: node docs/scratch/probe-ui-tour.mjs
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(9000);
const shot = (n) => page.screenshot({ path: `docs/scratch/shots/ui-${n}.png` });
await shot('main');

// Click the centre of the bakery (or the first building) on the canvas.
const target = await page.evaluate(async () => {
  const { trpcClient } = await import('/src/lib/trpc.ts');
  const locs = await trpcClient.locations.getAll.query();
  const l = locs.find(x => x.type === 'bakery') ?? locs.find(x => x.type === 'shop');
  const bus = await import('/src/lib/canvasBus.ts');
  bus.emitCanvasEvent({ type: 'focusLocation', locationId: l.id });
  return l.name;
});
await page.waitForTimeout(900);
const box = await page.locator('canvas').first().boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(800);
await shot('location');
console.log('clicked', target);

await page.keyboard.press('Escape');
await page.getByRole('button', { name: /events/i }).first().click().catch(e => console.log('no events button', e.message));
await page.waitForTimeout(700);
await shot('events');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

await page.getByRole('button', { name: /autoplay/i }).first().click().catch(e => console.log('no autoplay button', e.message));
await page.waitForTimeout(1200);
await shot('autoplay');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// Select an agent through the feed/portrait path the app itself uses.
await page.evaluate(async () => {
  const { trpcClient } = await import('/src/lib/trpc.ts');
  const a = (await trpcClient.agents.getActive.query())[0];
  const bus = await import('/src/lib/canvasBus.ts');
  bus.emitCanvasEvent({ type: 'focus', x: a.position.x, y: a.position.y });
});
await page.waitForTimeout(800);
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(1500);
await shot('agent');

console.log('errors:', errors.slice(0, 8));
await browser.close();
