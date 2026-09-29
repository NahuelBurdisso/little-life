// Fires each player-intervention kind straight onto the canvas bus (no server action)
// around two awake agents and screenshots each effect. Verify server must be running.
// Usage: node docs/scratch/probe-player-fx.mjs
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(9000);

const pick = await page.evaluate(async () => {
  const { trpcClient } = await import('/src/lib/trpc.ts');
  const agents = await trpcClient.agents.getActive.query();
  const locs = await trpcClient.locations.getAll.query();
  const awake = agents.filter(a => !['sleeping', 'dead'].includes(a.current_action?.type ?? a.current_action));
  // Closest awake pair, so both fit in one shot.
  let best = null;
  for (const a of awake) for (const b of awake) {
    if (a.id >= b.id) continue;
    const d = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
    if (!best || d < best.d) best = { a, b, d };
  }
  const sq = locs.find(l => l.type === 'town_square') ?? locs[0];
  return best && { a: { id: best.a.id, name: best.a.name, ...best.a.position }, b: { id: best.b.id, name: best.b.name, ...best.b.position }, d: best.d, sq: sq.id };
});
console.log('pair:', pick);
if (!pick) { await browser.close(); process.exit(1); }

const box = await page.locator('canvas').first().boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const emit = (e) => page.evaluate(async (ev) => { (await import('/src/lib/canvasBus.ts')).emitCanvasEvent(ev); }, e);
await emit({ type: 'focus', x: (pick.a.x + pick.b.x) / 2, y: (pick.a.y + pick.b.y) / 2 });
await page.waitForTimeout(600);
for (let i = 0; i < 3; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -240); await page.waitForTimeout(150); }
await page.mouse.move(box.x + 5, box.y + 5);
await page.waitForTimeout(800);

const shots = [
  ['give_money', { kind: 'give_money', agentIds: [pick.a.id], amount: 50 }, 700],
  ['suggest_talk', { kind: 'suggest_talk', agentIds: [pick.a.id, pick.b.id] }, 900],
  ['tell_secret', { kind: 'tell_secret', agentIds: [pick.a.id, pick.b.id] }, 700],
  ['force_confront', { kind: 'force_confront', agentIds: [pick.a.id, pick.b.id] }, 600],
  ['suggest_go_to', { kind: 'suggest_go_to', agentIds: [pick.a.id], locationId: pick.sq }, 900],
];
for (const [name, ev, wait] of shots) {
  await emit({ type: 'intervention', ...ev });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `docs/scratch/shots/fx-${name}.png`, clip: box });
  await page.waitForTimeout(1800);
}
console.log('errors:', errors.slice(0, 8));
await browser.close();
