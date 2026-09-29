// Integration probe for the living-canvas systems (run against the verify dev server).
// Loads the page, records atlas loads + console errors, sets sunny weather, triggers a
// festival, centres the town square, fires a player-intervention on the canvas bus,
// captures shots, and samples frame rate.
// Usage: node docs/scratch/probe-living-canvas.mjs [squareX squareY]  (page coords at load)
import { chromium } from 'playwright';

const sqX = Number(process.argv[2] ?? 862), sqY = Number(process.argv[3] ?? 475);
// GPU-backed so frame rates mean something (headless defaults to software GL).
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const query = process.env.NOSYSTEMS ? '?nosystems' : '';
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [], atlases = new Set();
page.on('console', m => { if (m.type() === 'error' || m.text().includes('[canvas systems]')) errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
// Every fx atlas, plus any other sprite that failed to load.
page.on('response', r => { if (r.url().includes('/sprites/') && (r.url().includes('/sprites/fx/') || r.status() >= 400)) atlases.add(`${r.status()} ${r.url().split('/sprites/')[1]}`); });
await page.goto('http://localhost:5173/' + query);
await page.waitForTimeout(9000);
await page.getByRole('button', { name: '1x', exact: true }).click().catch(() => {});

const fps = () => page.evaluate(() => new Promise(res => {
  let n = 0; const t0 = performance.now(); let worst = 0, last = t0;
  const f = (t) => { n++; worst = Math.max(worst, t - last); last = t;
    if (t - t0 < 4000) requestAnimationFrame(f); else res({ fps: +(n / ((t - t0) / 1000)).toFixed(1), worstMs: +worst.toFixed(1) }); };
  requestAnimationFrame(f);
}));
console.log('fps before events:', await fps());

// Sunny weather + the event under test, through the app's own tRPC client (Vite serves the module).
const eventType = process.env.EVENT ?? 'festival';
console.log('trigger:', await page.evaluate(async (type) => {
  const { trpcClient } = await import('/src/lib/trpc.ts');
  const c = trpcClient;
  const out = [];
  try { await c.world.setWeather.mutate({ weather: 'sunny', durationHours: 4 }); out.push('sunny ok'); } catch (e) { out.push('weather: ' + e.message); }
  try { await c.world.triggerEvent.mutate({ type }); out.push(type + ' ok'); } catch (e) { out.push('event: ' + e.message); }
  return out;
}, eventType));
await page.waitForTimeout(3000);

const box = await page.locator('canvas').first().boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(sqX, sqY); await page.mouse.down();
await page.mouse.move(cx, cy, { steps: 15 }); await page.mouse.up();
for (let i = 0; i < 3; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -240); await page.waitForTimeout(150); }
await page.mouse.move(box.x + 5, box.y + 5);
await page.waitForTimeout(1500);
await page.screenshot({ path: `docs/scratch/shots/living-${eventType}.png`, clip: box });

// Player intervention on one on-screen agent (PROBE_AGENT, default Marco Rivera).
console.log('intervened:', await page.evaluate(async (name) => {
  const { trpcClient } = await import('/src/lib/trpc.ts');
  const agents = await trpcClient.agents.getActive.query();
  const a = agents.find((x) => x.name === name);
  if (!a) return 'no agent ' + name;
  const bus = await import('/src/lib/canvasBus.ts');
  bus.emitCanvasEvent({ type: 'intervention', kind: 'probe', agentIds: [a.id] });
  return name + ' #' + a.id;
}, process.env.PROBE_AGENT ?? 'Marco Rivera'));
await page.waitForTimeout(250);
await page.screenshot({ path: 'docs/scratch/shots/living-intervention.png', clip: box });
console.log('fps with festival + systems:', await fps());

const objects = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  return c ? `${c.width}x${c.height}` : 'no canvas';
});
console.log('canvas:', objects);
console.log('atlases:', [...atlases].sort().join(', '));
console.log('errors:', errors.slice(0, 8));
await browser.close();
