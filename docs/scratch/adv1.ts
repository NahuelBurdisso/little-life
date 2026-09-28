import { generateWorld } from '../../server/lib/worldgen/pipeline';
import { computeRoadPositions, deriveZones } from '../../server/lib/worldgen/stages/roads';
import { TILE, BUILDING_GAP } from '../../server/lib/worldgen/config';
import { ENCLOSED_BUILDING_TYPES, DERIVED_LOCATION_TYPES } from '../../server/lib/worldgen/buildingTemplates';

const TILEN = TILE;

function tiles(l: any) {
  return {
    x: l.position.x / TILEN,
    y: l.position.y / TILEN,
    w: l.position.width / TILEN,
    h: l.position.height / TILEN,
    ex: Math.floor(l.entry_point.x / TILEN),
    ey: Math.floor(l.entry_point.y / TILEN),
    type: l.type,
    name: l.name,
  };
}

const counts = [5, 13, 20, 30, 32];
const N = 200;

const issues: Record<string, number> = {};
const examples: Record<string, string> = {};
function bump(k: string, ex: string) {
  issues[k] = (issues[k] ?? 0) + 1;
  if (!examples[k]) examples[k] = ex;
}

let totalWorlds = 0;
const warnCount: Record<string, Record<string, number>> = {};

for (const n of counts) {
  warnCount[n] = { alley: 0, farmyard: 0, market: 0, total: 0 };
  for (let s = 0; s < N; s++) {
    const seed = `adv-${n}-${s}`;
    let w;
    try {
      w = generateWorld({ seed, sizeTier: 'auto', overrides: {} } as any, n, {});
    } catch (e: any) {
      bump('generateWorld threw', `${seed}: ${e.message}`);
      continue;
    }
    totalWorlds++;
    warnCount[n].total++;
    for (const wr of w.warnings) {
      if (wr.includes('alley')) warnCount[n].alley++;
      else if (wr.includes('farmyard')) warnCount[n].farmyard++;
      else if (wr.includes('market')) warnCount[n].market++;
    }

    const { width, height } = w.dimensions;
    const roadSet = new Set(w.roads.map((t) => `${t.x},${t.y}`));
    const locs = w.locations.map(tiles);

    // fractional pixels
    for (const l of w.locations) {
      for (const [k, v] of Object.entries(l.position)) {
        if (!Number.isInteger(v as number)) bump('non-integer position', `${seed} ${l.type} ${k}=${v}`);
      }
    }

    // bounds
    for (const l of locs) {
      if (l.x < 0 || l.y < 0 || l.x + l.w > width || l.y + l.h > height) {
        bump('footprint out of bounds', `${seed} ${l.type} @${l.x},${l.y} ${l.w}x${l.h} map ${width}x${height}`);
      }
      if (l.ex < 0 || l.ey < 0 || l.ex >= width || l.ey >= height) {
        bump('door out of bounds', `${seed} ${l.type} door ${l.ex},${l.ey} map ${width}x${height}`);
      }
    }

    // door on road (except mainstreet)
    for (const l of locs) {
      if (l.type === 'mainstreet') continue;
      if (roadSet.has(`${l.ex},${l.ey}`)) bump('door on road', `${seed} ${l.type} door ${l.ex},${l.ey}`);
    }

    // footprint overlapping road (except mainstreet)
    for (const l of locs) {
      if (l.type === 'mainstreet') continue;
      for (let y = l.y; y < l.y + l.h; y++)
        for (let x = l.x; x < l.x + l.w; x++)
          if (roadSet.has(`${x},${y}`)) { bump('footprint on road', `${seed} ${l.type} @${l.x},${l.y} ${l.w}x${l.h} tile ${x},${y}`); y = l.y + l.h; break; }
    }

    // pairwise footprint overlap (exclude mainstreet which is the road itself)
    for (let i = 0; i < locs.length; i++) {
      for (let j = i + 1; j < locs.length; j++) {
        const a = locs[i], b = locs[j];
        if (a.type === 'mainstreet' || b.type === 'mainstreet') continue;
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
          bump(`overlap ${[a.type, b.type].sort().join('×')}`, `${seed} ${a.type}@${a.x},${a.y} ${a.w}x${a.h} vs ${b.type}@${b.x},${b.y} ${b.w}x${b.h}`);
        }
      }
    }

    // door inside another location's footprint
    for (const a of locs) {
      if (a.type === 'mainstreet') continue;
      for (const b of locs) {
        if (a === b || b.type === 'mainstreet') continue;
        if (a.ex >= b.x && a.ex < b.x + b.w && a.ey >= b.y && a.ey < b.y + b.h) {
          bump(`door of ${a.type} inside ${b.type}`, `${seed} ${a.type} door ${a.ex},${a.ey} in ${b.type}@${b.x},${b.y} ${b.w}x${b.h}`);
        }
      }
    }

    // BUILDING_GAP between enclosed/template buildings (not derived, not homes-vs?)
    const solid = locs.filter((l) => !DERIVED_LOCATION_TYPES.has(l.type));
    for (let i = 0; i < solid.length; i++) {
      for (let j = i + 1; j < solid.length; j++) {
        const a = solid[i], b = solid[j];
        const gx = Math.max(0, Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)));
        const gy = Math.max(0, Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h)));
        if (Math.max(gx, gy) < BUILDING_GAP) {
          bump('BUILDING_GAP violation', `${seed} ${a.type}@${a.x},${a.y}${a.w}x${a.h} vs ${b.type}@${b.x},${b.y}${b.w}x${b.h} gap ${gx},${gy}`);
        }
      }
    }
  }
}

console.log('worlds:', totalWorlds);
console.log('--- issues ---');
for (const [k, v] of Object.entries(issues)) {
  console.log(`${v.toString().padStart(6)}  ${k}`);
  console.log(`        eg ${examples[k]}`);
}
console.log('--- warnings by agent count (pct of worlds) ---');
for (const [n, c] of Object.entries(warnCount)) {
  console.log(`n=${n} total=${c.total} noAlley=${(100 * c.alley / c.total).toFixed(1)}% noFarmyard=${(100 * c.farmyard / c.total).toFixed(1)}% noMarket=${(100 * c.market / c.total).toFixed(1)}%`);
}
