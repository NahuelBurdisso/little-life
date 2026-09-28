/* Probe 2: alley door defect + open-area-on-road + expand stress. Read-only. */
import { generateWorld } from '../../server/lib/worldgen/pipeline';
import { ENCLOSED_BUILDING_TYPES } from '../../server/lib/worldgen/buildingTemplates';

const TILE = 32;
const origLog = console.log, origWarn = console.warn;
const mute = () => { console.log = () => {}; console.warn = () => {}; };
const unmute = () => { console.log = origLog; console.warn = origWarn; };

const tileRect = (l: any) => ({
  x0: Math.floor(l.position.x / TILE),
  y0: Math.floor(l.position.y / TILE),
  w: Math.ceil(l.position.width / TILE),
  h: Math.ceil(l.position.height / TILE),
});

// ---------------------------------------------------------------------------
// Part A — which location types get a blocked door, and why
// ---------------------------------------------------------------------------
const byType: Record<string, { blocked: number; total: number }> = {};
const alleyExamples: string[] = [];
const openOnRoad: string[] = [];

mute();
for (const n of [4, 8, 12, 16, 24, 30]) {
  for (let i = 0; i < 60; i++) {
    const seed = `audit-${n}-${i}`;
    const r = generateWorld({ sizeTier: 'auto', overrides: {}, seed } as any, n);
    const { width: W, height: H } = r.dimensions;
    const at = (x: number, y: number) => r.collisionGrid[y * W + x];
    const roadSet = new Set(r.roads.map((t) => `${t.x},${t.y}`));

    for (const l of r.locations) {
      byType[l.type] ??= { blocked: 0, total: 0 };
      byType[l.type].total++;
      const dx = Math.floor(l.entry_point.x / TILE), dy = Math.floor(l.entry_point.y / TILE);
      if (at(dx, dy) === '1') {
        byType[l.type].blocked++;
        if (l.type === 'alley' && alleyExamples.length < 4) {
          // which building contains the door?
          const owner = r.locations.find((o) => {
            if (!ENCLOSED_BUILDING_TYPES.has(o.type)) return false;
            const q = tileRect(o);
            return dx >= q.x0 && dx < q.x0 + q.w && dy >= q.y0 && dy < q.y0 + q.h;
          });
          const q = tileRect(l);
          alleyExamples.push(
            `seed=${seed} n=${n} alley tiles x=${q.x0} y=${q.y0} ${q.w}x${q.h} ` +
            `door=(${dx},${dy}) insideBuilding=${owner ? owner.name + ' ' + JSON.stringify(tileRect(owner)) : 'NONE'}`,
          );
        }
      }
      // open-area / derived locations sitting on road tiles
      if (!ENCLOSED_BUILDING_TYPES.has(l.type) && l.type !== 'mainstreet') {
        const q = tileRect(l);
        for (let y = q.y0; y < q.y0 + q.h; y++)
          for (let x = q.x0; x < q.x0 + q.w; x++)
            if (roadSet.has(`${x},${y}`) && openOnRoad.length < 5)
              openOnRoad.push(`seed=${seed} ${l.name}(${l.type}) covers road ${x},${y}`);
      }
    }
  }
}
unmute();

console.log('--- blocked-door rate by location type ---');
for (const [t, v] of Object.entries(byType).sort((a, b) => b[1].blocked - a[1].blocked))
  console.log(`  ${t.padEnd(14)} blocked=${v.blocked}/${v.total}`);
console.log('');
console.log('--- alley examples ---');
alleyExamples.forEach((e) => console.log('  ' + e));
console.log('');
console.log('--- open-area location on road tiles ---');
console.log(openOnRoad.length ? openOnRoad.join('\n') : '  none');

// ---------------------------------------------------------------------------
// Part B — expand / FitError stress
// ---------------------------------------------------------------------------
console.log('');
console.log('--- expand stress (auto tier) ---');
for (const n of [40, 50, 60, 70, 80, 100]) {
  mute();
  let ok = 0, err: string | null = null;
  const dims: string[] = [];
  for (let i = 0; i < 8; i++) {
    try {
      const r = generateWorld({ sizeTier: 'auto', overrides: {}, seed: `ex-${n}-${i}` } as any, n);
      ok++;
      dims.push(`${r.dimensions.width}x${r.dimensions.height}`);
    } catch (e: any) {
      err ??= e.message;
    }
  }
  unmute();
  console.log(`  agents=${n} ok=${ok}/8 dims=${[...new Set(dims)].join(',')} firstErr=${err ?? '-'}`);
}

// ---------------------------------------------------------------------------
// Part C — homes stage override path / determinism across differing agent lists
// ---------------------------------------------------------------------------
console.log('');
console.log('--- FitError leaves no partial state / repeat determinism after expand ---');
mute();
const a1 = generateWorld({ sizeTier: 'auto', overrides: {}, seed: 'exp-det' } as any, 60);
const a2 = generateWorld({ sizeTier: 'auto', overrides: {}, seed: 'exp-det' } as any, 60);
unmute();
console.log(`  identical after expand: ${JSON.stringify(a1) === JSON.stringify(a2)} dims=${a1.dimensions.width}x${a1.dimensions.height}`);
