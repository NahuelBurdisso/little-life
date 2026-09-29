import { generateWorld } from '../../server/lib/worldgen/pipeline';
import { computeRoadPositions, deriveZones } from '../../server/lib/worldgen/stages/roads';
import { buildRoadDistance } from '../../server/lib/worldgen/stages/roadDistance';
import { TILE, MIN_WIDTH, MIN_HEIGHT, MAX_WIDTH, MAX_HEIGHT } from '../../server/lib/worldgen/config';
import { DERIVED_LOCATION_TYPES } from '../../server/lib/worldgen/buildingTemplates';

// ---- 1. zone area ratio across every legal map size -------------------------
let worstRatio = 0, bestRatio = 99, worstAt = '', bestAt = '';
for (let w = MIN_WIDTH; w <= MAX_WIDTH; w++) {
  for (let h = MIN_HEIGHT; h <= MAX_HEIGHT; h++) {
    const zs = deriveZones(computeRoadPositions(w, h), w, h);
    const areas = zs.map((z) => (z.bounds.x2 - z.bounds.x1 + 1) * (z.bounds.y2 - z.bounds.y1 + 1));
    const r = Math.max(...areas) / Math.min(...areas);
    if (r > worstRatio) { worstRatio = r; worstAt = `${w}x${h}`; }
    if (r < bestRatio) { bestRatio = r; bestAt = `${w}x${h}`; }
  }
}
console.log(`zone area ratio over all legal sizes: min ${bestRatio.toFixed(3)} (${bestAt}) max ${worstRatio.toFixed(3)} (${worstAt})`);

// only the sizes actually reachable
const REACH = [[56,43],[57,44],[59,45],[62,48],[60,45],[80,60]];
for (const [w,h] of REACH) {
  const zs = deriveZones(computeRoadPositions(w, h), w, h);
  const areas = zs.map((z) => (z.bounds.x2 - z.bounds.x1 + 1) * (z.bounds.y2 - z.bounds.y1 + 1));
  console.log(`  ${w}x${h}: ratio ${(Math.max(...areas)/Math.min(...areas)).toFixed(3)} areas ${areas.join(',')}`);
}

// ---- 2. furthest tile from a road -------------------------------------------
for (const [w,h] of [[56,43],[62,48],[90,70]]) {
  const r = computeRoadPositions(w,h);
  const tiles: Array<{x:number;y:number}> = [];
  for (let x = 1; x < w - 1; x++) { tiles.push({x,y:r.mainStreetY}); tiles.push({x,y:r.mainStreetY+1}); tiles.push({x,y:r.crossPathY}); tiles.push({x,y:r.crossPathY+1}); }
  for (let y = 1; y < h - 1; y++) { tiles.push({x:r.vertWestX,y}); tiles.push({x:r.vertWestX+1,y}); tiles.push({x:r.vertEastX,y}); tiles.push({x:r.vertEastX+1,y}); }
  const d = buildRoadDistance(w,h,tiles);
  let mx = 0; for (let i=0;i<d.length;i++) if (d[i] > mx && d[i] < 1e9) mx = d[i];
  console.log(`furthest tile from road at ${w}x${h}: ${mx}`);
}

// ---- 3. per-world stats ------------------------------------------------------
function run(n: number, seeds: number) {
  let doorNear2 = 0, doorTot = 0, door6 = 0;
  let mkBeyond = 0, mkTot = 0;
  const mkGaps: number[] = [];
  const parkOrigins = new Set<string>();
  const originsByType = new Map<string, Set<string>>();
  let noAlley = 0, noFarm = 0, noMk = 0, anyWarn = 0;
  for (let s = 0; s < seeds; s++) {
    const w = generateWorld({ seed: `m-${n}-${s}`, sizeTier: 'auto', overrides: {} } as any, n, {});
    const { width, height } = w.dimensions;
    const rd = buildRoadDistance(width, height, w.roads);
    for (const l of w.locations) {
      if (l.type === 'home' || l.type === 'mainstreet') continue;
      if (DERIVED_LOCATION_TYPES.has(l.type)) continue;
      const ex = Math.floor(l.entry_point.x / TILE), ey = Math.floor(l.entry_point.y / TILE);
      const d = rd[ey * width + ex];
      doorTot++;
      if (d <= 2) doorNear2++;
      if (d > 6) door6++;
      const key = `${l.position.x / TILE},${l.position.y / TILE}`;
      if (!originsByType.has(l.type)) originsByType.set(l.type, new Set());
      originsByType.get(l.type)!.add(key);
      if (l.type === 'park') parkOrigins.add(key);
    }
    const ts = w.locations.find((l) => l.type === 'town_square');
    const mk = w.locations.find((l) => l.type === 'market_square');
    if (ts && mk) {
      const a = { x: ts.position.x/TILE, y: ts.position.y/TILE, w: ts.position.width/TILE, h: ts.position.height/TILE };
      const c = { x: mk.position.x/TILE, y: mk.position.y/TILE, w: mk.position.width/TILE, h: mk.position.height/TILE };
      const gap = Math.max(
        Math.max(a.x - (c.x + c.w), c.x - (a.x + a.w), 0),
        Math.max(a.y - (c.y + c.h), c.y - (a.y + a.h), 0),
      );
      mkGaps.push(gap);
      mkTot++;
      if (gap > 6) mkBeyond++;
    }
    let any = false;
    for (const wr of w.warnings) { any = true; if (wr.includes('alley')) noAlley++; else if (wr.includes('farmyard')) noFarm++; else if (wr.includes('market')) noMk++; }
    if (any) anyWarn++;
  }
  const hist: Record<number, number> = {};
  for (const g of mkGaps) hist[g] = (hist[g] ?? 0) + 1;
  console.log(`n=${n}: door<=2road ${(100*doorNear2/doorTot).toFixed(1)}%  door>6 ${(100*door6/doorTot).toFixed(1)}%  mkGap>6 ${(100*mkBeyond/Math.max(mkTot,1)).toFixed(0)}% hist ${JSON.stringify(hist)}  parkOrigins ${parkOrigins.size}  noAlley ${(100*noAlley/seeds).toFixed(1)}% noFarmyard ${(100*noFarm/seeds).toFixed(1)}% noMarket ${(100*noMk/seeds).toFixed(1)}% anyWarn ${(100*anyWarn/seeds).toFixed(1)}%`);
  const o = [...originsByType.entries()].map(([t, s2]) => `${t}:${s2.size}`).sort().join(' ');
  console.log(`   distinct origins: ${o}`);
}

for (const n of [5, 13, 20, 30]) run(n, 200);

// ---- 4. determinism ----------------------------------------------------------
let detOk = true;
for (let s = 0; s < 25; s++) {
  const a = generateWorld({ seed: `det-${s}`, sizeTier: 'auto', overrides: {} } as any, 20, {});
  const b = generateWorld({ seed: `det-${s}`, sizeTier: 'auto', overrides: {} } as any, 20, {});
  if (JSON.stringify(a) !== JSON.stringify(b)) { detOk = false; console.log('NONDETERMINISTIC', s); }
}
console.log('determinism ok:', detOk);
