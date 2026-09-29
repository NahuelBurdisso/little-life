// Runs the verify world at 4x until morning, sets cloudy weather, then shoots the town at
// two zoom levels plus a clicked building. Verify server must be running (never the user's DB).
// Usage: node docs/scratch/probe-daylight.mjs
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(8000);

const api = (fn, arg) => page.evaluate(async ([src, a]) => {
  const { trpcClient } = await import('/src/lib/trpc.ts');
  return new Function('c', 'a', `return (${src})(c, a)`)(trpcClient, a);
}, [fn.toString(), arg]);

await api(async (c) => c.nudge.execute.mutate({ action: { type: 'change_speed', speed: 4 } }));
for (let i = 0; i < 60; i++) {
  const w = await api(async (c) => c.world.getState.query());
  const h = w?.time?.hour ?? 0;
  if (h >= 9 && h < 17) { console.log('reached', w.time); break; }
  await page.waitForTimeout(5000);
}
await api(async (c) => c.nudge.execute.mutate({ action: { type: 'change_speed', speed: 1 } }));
console.log(await api(async (c) => c.world.setWeather.mutate({ weather: 'cloudy', durationHours: 4 })));
await page.waitForTimeout(4000);
await page.screenshot({ path: 'docs/scratch/shots/day-wide.png' });

const box = await page.locator('canvas').first().boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const locs = await api(async (c) => c.locations.getAll.query());
for (const type of ['workshop', 'tavern', 'farm', 'town_hall']) {
  const l = locs.find(x => x.type === type);
  if (!l) continue;
  await page.evaluate(async (id) => (await import('/src/lib/canvasBus.ts')).emitCanvasEvent({ type: 'focusLocation', locationId: id }), l.id);
  await page.waitForTimeout(700);
  for (let i = 0; i < 2; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -240); await page.waitForTimeout(150); }
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `docs/scratch/shots/day-${type}.png`, clip: box });
  for (let i = 0; i < 2; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, 240); await page.waitForTimeout(150); }
}
console.log('errors:', errors.slice(0, 8));
await browser.close();
