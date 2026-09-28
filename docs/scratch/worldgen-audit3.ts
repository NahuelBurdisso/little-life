/* Probe 3: farmyard dead code, pinned-home overlap, unbounded overrides.dimensions. */
import { generateWorld } from '../../server/lib/worldgen/pipeline';

const TILE = 32;
const origLog = console.log, origWarn = console.warn;
const mute = () => { console.log = () => {}; console.warn = () => {}; };
const unmute = () => { console.log = origLog; console.warn = origWarn; };

// --- A. farmyard never generated? wide sweep ---
mute();
const typeCounts: Record<string, number> = {};
let n = 0;
for (const agents of [4, 6, 8, 10, 12, 14, 16, 20, 24, 30, 40]) {
  for (let i = 0; i < 40; i++) {
    const r = generateWorld({ sizeTier: 'auto', overrides: {}, seed: `fy-${agents}-${i}` } as any, agents);
    n++;
    for (const l of r.locations) typeCounts[l.type] = (typeCounts[l.type] ?? 0) + 1;
  }
}
for (const tier of ['medium', 'large'] as const) {
  for (let i = 0; i < 40; i++) {
    const r = generateWorld({ sizeTier: tier, overrides: {}, seed: `fy-${tier}-${i}` } as any, 12);
    n++;
    for (const l of r.locations) typeCounts[l.type] = (typeCounts[l.type] ?? 0) + 1;
  }
}
unmute();
console.log(`--- derived outdoor location frequency over ${n} worlds ---`);
for (const t of ['mainstreet', 'market_square', 'alley', 'farmyard'])
  console.log(`  ${t.padEnd(14)} ${typeCounts[t] ?? 0}`);

// --- B. pinned home positions are not checked against each other ---
console.log('');
console.log('--- overrides.homePositions self-collision ---');
mute();
let pinResult: any = null, pinErr: string | null = null;
try {
  pinResult = generateWorld(
    {
      sizeTier: 'medium',
      seed: 'pin',
      overrides: { homePositions: [{ x: 3 * TILE, y: 3 * TILE }, { x: 3 * TILE, y: 3 * TILE }, { x: 4 * TILE, y: 3 * TILE }] },
    } as any,
    5,
  );
} catch (e: any) { pinErr = e.message; }
unmute();
if (pinErr) console.log('  threw: ' + pinErr);
else {
  const homes = pinResult.locations.filter((l: any) => l.type === 'home');
  console.log('  homes emitted: ' + JSON.stringify(homes.map((h: any) => [h.name, h.position.x, h.position.y])));
  const dup = homes.filter((h: any, i: number) =>
    homes.some((o: any, j: number) => j !== i &&
      h.position.x < o.position.x + o.position.width && h.position.x + h.position.width > o.position.x &&
      h.position.y < o.position.y + o.position.height && h.position.y + h.position.height > o.position.y));
  console.log('  overlapping homes: ' + dup.length);
}

// --- C. overrides.dimensions is unclamped ---
console.log('');
console.log('--- overrides.dimensions clamping ---');
for (const d of [{ width: 8, height: 8 }, { width: 400, height: 400 }]) {
  mute();
  let out = '';
  const t0 = Date.now();
  try {
    const r = generateWorld({ sizeTier: 'auto', seed: 'ovr', overrides: { dimensions: d } } as any, 6);
    out = `dims=${r.dimensions.width}x${r.dimensions.height} gridLen=${r.collisionGrid.length} terrain=${r.terrainTiles.length} ${Date.now() - t0}ms`;
  } catch (e: any) { out = 'threw: ' + e.message; }
  unmute();
  console.log(`  requested ${d.width}x${d.height} → ${out}`);
}

// --- D. what a "cap reached" failure actually reports ---
console.log('');
console.log('--- forced fit failure message ---');
mute();
let msg = 'no error';
try {
  generateWorld({ sizeTier: 'auto', seed: 'cap', overrides: { dimensions: { width: 20, height: 20 } } } as any, 6);
} catch (e: any) { msg = `${e.name}: ${e.message}`; }
unmute();
console.log('  ' + msg);
