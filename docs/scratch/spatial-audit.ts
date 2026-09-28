/**
 * THROWAWAY spatial-quality audit for the worldgen pipeline.
 * Run: cd /d/proyects/little-life && npx tsx docs/scratch/spatial-audit.ts
 * Optional: ... spatial-audit.ts --seeds 30 --maps 2
 */
import { generateWorld } from '../../server/lib/worldgen';
import { computeRoadPositions, deriveZones } from '../../server/lib/worldgen/stages/roads';
import { AGENT_SEEDS } from '../../server/data/agents';
import { computeAStarPath } from '../../server/lib/pathfinding';
import type { GenResult, LocationSeed } from '../../server/lib/worldgen/types';

const TILE = 32;
const argv = process.argv.slice(2);
const NUM_SEEDS = Number(argv[argv.indexOf('--seeds') + 1]) || 30;
const NUM_MAPS = Number(argv[argv.indexOf('--maps') + 1]) || 2;

const AGENT_COUNT = AGENT_SEEDS.length;
const agentsOpt = AGENT_SEEDS.map((a) => ({ homeName: a.homeName }));

// ─── helpers ──────────────────────────────────────────────────────────────────

const tx = (l: LocationSeed) => Math.floor(l.position.x / TILE);
const ty = (l: LocationSeed) => Math.floor(l.position.y / TILE);
const tw = (l: LocationSeed) => Math.round(l.position.width / TILE);
const th = (l: LocationSeed) => Math.round(l.position.height / TILE);
const ex = (l: LocationSeed) => Math.floor(l.entry_point.x / TILE);
const ey = (l: LocationSeed) => Math.floor(l.entry_point.y / TILE);

const OPEN_TYPES = new Set(['farm', 'park', 'town_square', 'mainstreet', 'market_square', 'alley', 'farmyard']);
const CATEGORY: Record<string, string> = {
  shop: 'commercial', tavern: 'commercial', bakery: 'commercial', pawnshop: 'commercial',
  divebar: 'commercial', workshop: 'commercial',
  town_hall: 'civic', prison: 'civic', town_square: 'civic', clinic: 'civic',
  farm: 'rural', park: 'rural',
  home: 'residential',
};
const SOCIAL_TYPES = new Set(['tavern', 'town_square', 'park', 'divebar', 'shop', 'bakery']);

const GLYPH: Record<string, string> = {
  home: 'h', shop: 'S', tavern: 'T', clinic: 'C', town_hall: 'H', town_square: 'Q',
  farm: 'F', park: 'P', bakery: 'B', workshop: 'W', prison: 'J', pawnshop: 'p', divebar: 'd',
  mainstreet: '', market_square: 'm', alley: 'a', farmyard: 'y',
};

function median(xs: number[]) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : 'n/a');

// ─── ASCII map ────────────────────────────────────────────────────────────────

function renderMap(g: GenResult): string {
  const { width, height } = g.dimensions;
  const grid: string[][] = Array.from({ length: height }, () => Array(width).fill('.'));

  const roadSet = new Set(g.roads.map((r) => `${r.x},${r.y}`));
  for (const r of g.roads) if (r.y >= 0 && r.y < height && r.x >= 0 && r.x < width) grid[r.y][r.x] = '=';

  // open areas first, then enclosed on top
  const ordered = [...g.locations].sort((a, b) => (OPEN_TYPES.has(a.type) ? 0 : 1) - (OPEN_TYPES.has(b.type) ? 0 : 1));
  for (const l of ordered) {
    if (l.type === 'mainstreet') continue;
    const gl = GLYPH[l.type] ?? '?';
    if (!gl) continue;
    const lower = OPEN_TYPES.has(l.type) ? gl.toLowerCase() : gl;
    for (let y = ty(l); y < ty(l) + th(l); y++) {
      for (let x = tx(l); x < tx(l) + tw(l); x++) {
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        grid[y][x] = OPEN_TYPES.has(l.type) ? lower : gl;
      }
    }
    if (!OPEN_TYPES.has(l.type)) {
      const dx = ex(l), dy = ey(l);
      if (dx >= 0 && dx < width && dy >= 0 && dy < height && !roadSet.has(`${dx},${dy}`)) grid[dy][dx] = '+';
      const wallY = dy - 1;
      if (wallY >= 0 && wallY < height) grid[wallY][dx] = '+';
    }
  }

  const lines: string[] = [];
  const ruler = '    ' + Array.from({ length: width }, (_, i) => (i % 10 === 0 ? String((i / 10) % 10) : ' ')).join('');
  lines.push(ruler);
  for (let y = 0; y < height; y++) {
    lines.push(String(y).padStart(3, ' ') + ' ' + grid[y].join(''));
  }
  return lines.join('\n');
}

// ─── path metrics ─────────────────────────────────────────────────────────────

function pathTiles(g: GenResult, a: LocationSeed, b: LocationSeed): { len: number; tiles: string[] } | null {
  const wp = computeAStarPath(
    { x: a.entry_point.x, y: a.entry_point.y },
    { x: b.entry_point.x, y: b.entry_point.y },
    g.collisionGrid, g.dimensions.width, g.dimensions.height, TILE,
  );
  if (!wp.length) return null;
  // detect fallback straight line (2 points that aren't adjacent tiles)
  const tiles = wp.map((p) => `${Math.floor(p[0] / TILE)},${Math.floor(p[1] / TILE)}`);
  return { len: wp.length, tiles };
}

// ─── main ─────────────────────────────────────────────────────────────────────

interface SeedStat {
  seed: string;
  dims: { width: number; height: number };
  locCount: number;
  typePos: Record<string, string>;    // type -> "x,y"
  typeZone: Record<string, string>;   // type -> zone id
  outdoorPresent: Record<string, boolean>;
  ruleViolations: Record<string, number>;
  homeWork: number[];                  // tiles
  homeSocial: Record<string, number[]>;
  prefDist: number[];
  strandedNotes: string[];
  trafficCoverage: number;             // fraction of walkable tiles with >=1 route passing
  emptyRegion: { w: number; h: number; x: number; y: number };
  clusterRatio: Record<string, number>;
  venueSpread: number;
  homeSpread: number;
  centroidDist: Record<string, number>;
}

function zoneOf(zones: ReturnType<typeof deriveZones>, x: number, y: number): string {
  for (const z of zones) {
    if (x >= z.bounds.x1 && x <= z.bounds.x2 && y >= z.bounds.y1 && y <= z.bounds.y2) return z.id;
  }
  return '--';
}

function analyze(seed: string): { g: GenResult; s: SeedStat } {
  const g = generateWorld({ seed, sizeTier: 'auto', overrides: {} } as any, AGENT_COUNT, { agents: agentsOpt });
  const { width, height } = g.dimensions;
  const rp = computeRoadPositions(width, height);
  const zones = deriveZones(rp, width, height);
  const roadSet = new Set(g.roads.map((r) => `${r.x},${r.y}`));

  const byName = new Map(g.locations.map((l) => [l.name, l]));
  const byType = new Map<string, LocationSeed[]>();
  for (const l of g.locations) {
    if (!byType.has(l.type)) byType.set(l.type, []);
    byType.get(l.type)!.push(l);
  }

  // ── rule checks ──
  const v: Record<string, number> = {
    overlapRoad: 0, borderLt2: 0, gapLt2: 0, roadGapLt1: 0,
    doorBlocked: 0, doorOffMap: 0, unreachablePair: 0, footprintOverlap: 0,
    doorOnRoadTile: 0, homeBorderLt2: 0,
  };
  const solid = g.locations.filter((l) => !OPEN_TYPES.has(l.type));
  for (const l of solid) {
    const x0 = tx(l), y0 = ty(l), w = tw(l), h = th(l);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (roadSet.has(`${x},${y}`)) v.overlapRoad++;
    const bd = Math.min(x0, y0, width - (x0 + w), height - (y0 + h));
    if (bd < 2) { v.borderLt2++; if (l.type === 'home') v.homeBorderLt2++; }
    // road gap
    let minRoadGap = Infinity;
    for (const r of g.roads) {
      const dx = Math.max(x0 - r.x, r.x - (x0 + w - 1), 0);
      const dy = Math.max(y0 - r.y, r.y - (y0 + h - 1), 0);
      minRoadGap = Math.min(minRoadGap, Math.max(dx, dy));
    }
    if (minRoadGap < 1) v.roadGapLt1++;
    // door
    const dx = ex(l), dy = ey(l);
    if (dx < 0 || dx >= width || dy < 0 || dy >= height) v.doorOffMap++;
    else if (g.collisionGrid[dy * width + dx] === '1') v.doorBlocked++;
  }
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i], b = solid[j];
      const gapX = Math.max(tx(a) - (tx(b) + tw(b) - 1), tx(b) - (tx(a) + tw(a) - 1));
      const gapY = Math.max(ty(a) - (ty(b) + th(b) - 1), ty(b) - (ty(a) + th(a) - 1));
      const gap = Math.max(gapX, gapY) - 1;
      if (gap < 0) v.footprintOverlap++;
      else if (gap < 2) v.gapLt2++;
    }
  }

  // ── connectivity + traffic ──
  const traffic = new Map<string, number>();
  function addRoute(a: LocationSeed, b: LocationSeed) {
    const p = pathTiles(g, a, b);
    if (!p) { v.unreachablePair++; return NaN; }
    // fallback detection: A* returns 2 waypoints for a long trip = no path
    const manh = Math.max(Math.abs(ex(a) - ex(b)), Math.abs(ey(a) - ey(b)));
    if (p.len <= 2 && manh > 2) { v.unreachablePair++; return NaN; }
    for (const t of p.tiles) traffic.set(t, (traffic.get(t) ?? 0) + 1);
    return p.len;
  }

  const homeWork: number[] = [];
  const homeSocial: Record<string, number[]> = {};
  const prefDist: number[] = [];
  const strandedNotes: string[] = [];

  for (const a of AGENT_SEEDS) {
    const home = byName.get(a.homeName);
    if (!home) { strandedNotes.push(`${a.name}: home ${a.homeName} MISSING`); continue; }
    if (a.workplaceName) {
      const work = byName.get(a.workplaceName);
      if (work) {
        const d = addRoute(home, work);
        if (Number.isFinite(d)) homeWork.push(d);
        if (d > 45) strandedNotes.push(`${a.name} home→work ${d}t (${d * 2}min)`);
      }
    }
    for (const pref of a.schedule.freeTimePreferences) {
      if (pref === 'home') continue;
      const cands = byType.get(pref) ?? [];
      if (!cands.length) continue;
      const d = addRoute(home, cands[0]);
      if (Number.isFinite(d)) {
        prefDist.push(d);
        (homeSocial[pref] ??= []).push(d);
      }
    }
  }
  // work → social venues (evening commute)
  for (const a of AGENT_SEEDS) {
    if (!a.workplaceName) continue;
    const work = byName.get(a.workplaceName);
    if (!work) continue;
    for (const pref of a.schedule.freeTimePreferences) {
      if (pref === 'home') { const h = byName.get(a.homeName); if (h) addRoute(work, h); continue; }
      const cands = byType.get(pref) ?? [];
      if (cands.length) addRoute(work, cands[0]);
    }
  }

  // ── walkable coverage / dead space ──
  let walkable = 0, covered = 0;
  const dead: boolean[][] = Array.from({ length: height }, () => Array(width).fill(false));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (g.collisionGrid[y * width + x] === '1') continue;
      walkable++;
      // "near traffic" = within 2 tiles of a routed tile
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++)
        for (let dx = -2; dx <= 2 && !near; dx++)
          if (traffic.has(`${x + dx},${y + dy}`)) near = true;
      if (near) covered++; else dead[y][x] = true;
    }
  }
  // largest all-dead rectangle (histogram method)
  let best = { w: 0, h: 0, x: 0, y: 0 };
  const heights = new Array(width).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) heights[x] = dead[y][x] ? heights[x] + 1 : 0;
    const stack: number[] = [];
    for (let x = 0; x <= width; x++) {
      const cur = x === width ? 0 : heights[x];
      while (stack.length && heights[stack[stack.length - 1]] >= cur) {
        const hgt = heights[stack.pop()!];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const wid = x - left;
        if (hgt * wid > best.w * best.h) best = { w: wid, h: hgt, x: left, y: y - hgt + 1 };
      }
      stack.push(x);
    }
  }

  // ── clustering ──
  const centers = g.locations
    .filter((l) => l.type !== 'mainstreet')
    .map((l) => ({ type: l.type, cat: CATEGORY[l.type] ?? 'other', x: tx(l) + tw(l) / 2, y: ty(l) + th(l) / 2 }));
  const allPairs: number[] = [];
  for (let i = 0; i < centers.length; i++) for (let j = i + 1; j < centers.length; j++)
    allPairs.push(Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y));
  const globalMean = mean(allPairs);
  const clusterRatio: Record<string, number> = {};
  for (const cat of ['commercial', 'civic', 'residential']) {
    const c = centers.filter((k) => k.cat === cat);
    const ds: number[] = [];
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++)
      ds.push(Math.hypot(c[i].x - c[j].x, c[i].y - c[j].y));
    clusterRatio[cat] = mean(ds) / globalMean;
  }

  // ── spread / centrality of social venues ──
  const cx = mean(centers.map((c) => c.x)), cy = mean(centers.map((c) => c.y));
  const venues = centers.filter((c) => SOCIAL_TYPES.has(c.type));
  const venuePairs: number[] = [];
  for (let i = 0; i < venues.length; i++) for (let j = i + 1; j < venues.length; j++)
    venuePairs.push(Math.hypot(venues[i].x - venues[j].x, venues[i].y - venues[j].y));
  const homes = centers.filter((c) => c.type === 'home');
  const homePairs: number[] = [];
  for (let i = 0; i < homes.length; i++) for (let j = i + 1; j < homes.length; j++)
    homePairs.push(Math.hypot(homes[i].x - homes[j].x, homes[i].y - homes[j].y));

  const centroidDist: Record<string, number> = {};
  for (const c of centers) if (c.type !== 'home') centroidDist[c.type] = Math.hypot(c.x - cx, c.y - cy);

  const typePos: Record<string, string> = {};
  const typeZone: Record<string, string> = {};
  for (const l of g.locations) {
    if (l.type === 'home' || l.type === 'mainstreet') continue;
    typePos[l.type] = `${tx(l)},${ty(l)}`;
    typeZone[l.type] = zoneOf(zones, Math.floor(tx(l) + tw(l) / 2), Math.floor(ty(l) + th(l) / 2));
  }

  return {
    g,
    s: {
      seed, dims: g.dimensions, locCount: g.locations.length, typePos, typeZone,
      outdoorPresent: {
        mainstreet: !!byType.get('mainstreet'),
        market_square: !!byType.get('market_square'),
        alley: !!byType.get('alley'),
        farmyard: !!byType.get('farmyard'),
      },
      ruleViolations: v,
      homeWork, homeSocial, prefDist, strandedNotes,
      trafficCoverage: covered / walkable,
      emptyRegion: best,
      clusterRatio,
      venueSpread: mean(venuePairs),
      homeSpread: mean(homePairs),
      centroidDist,
    },
  };
}

// ─── run ──────────────────────────────────────────────────────────────────────

const seeds = Array.from({ length: NUM_SEEDS }, (_, i) => `audit-${i}`);
const results = seeds.map((s) => analyze(s));

console.log('\n\n════════════════ REPRESENTATIVE MAPS ════════════════');
console.log('legend: . grass  = road  + door/approach  h home  S shop  T tavern  C clinic');
console.log('        H town_hall  q town_square  f farm  p park  B bakery  W workshop');
console.log('        J prison  p pawnshop(cap p vs park lower)  d divebar  m market_square  a alley  y farmyard\n');
for (let i = 0; i < NUM_MAPS; i++) {
  const { g, s } = results[i];
  console.log(`--- seed ${s.seed}  ${g.dimensions.width}x${g.dimensions.height}  locations=${s.locCount} ---`);
  console.log(renderMap(g));
  console.log('');
}

console.log('\n════════════════ 1. RULE CONFORMANCE (totals over ' + NUM_SEEDS + ' seeds) ════════════════');
const keys = Object.keys(results[0].s.ruleViolations);
for (const k of keys) {
  const tot = results.reduce((a, r) => a + r.s.ruleViolations[k], 0);
  const seedsHit = results.filter((r) => r.s.ruleViolations[k] > 0).length;
  console.log(`  ${k.padEnd(20)} total=${String(tot).padStart(5)}  seeds affected=${seedsHit}/${NUM_SEEDS}`);
}
console.log('  outdoor locations derived:');
for (const k of ['mainstreet', 'market_square', 'alley', 'farmyard']) {
  const n = results.filter((r) => r.s.outdoorPresent[k]).length;
  console.log(`    ${k.padEnd(15)} present in ${n}/${NUM_SEEDS} seeds`);
}
const dimSet = new Map<string, number>();
for (const r of results) {
  const k = `${r.s.dims.width}x${r.s.dims.height}`;
  dimSet.set(k, (dimSet.get(k) ?? 0) + 1);
}
console.log('  dimensions:', [...dimSet].map(([k, n]) => `${k}×${n}`).join(' '));

console.log('\n════════════════ 2. WALKING DISTANCES (tiles; 1 tile = 2 game-min) ════════════════');
const allHW = results.flatMap((r) => r.s.homeWork);
const allPref = results.flatMap((r) => r.s.prefDist);
console.log(`  home→work   n=${allHW.length}  mean=${f1(mean(allHW))}t (${f1(mean(allHW) * 2)}min)  median=${f1(median(allHW))}t  max=${Math.max(...allHW)}t (${Math.max(...allHW) * 2}min)`);
console.log(`  home→free-time venue  n=${allPref.length}  mean=${f1(mean(allPref))}t (${f1(mean(allPref) * 2)}min)  median=${f1(median(allPref))}t  max=${Math.max(...allPref)}t`);
const pctOver = (xs: number[], t: number) => ((xs.filter((x) => x > t).length / xs.length) * 100).toFixed(0);
console.log(`  home→work  >30t (60min one way): ${pctOver(allHW, 30)}%   >45t (90min): ${pctOver(allHW, 45)}%`);
console.log(`  home→venue >30t: ${pctOver(allPref, 30)}%   >45t: ${pctOver(allPref, 45)}%`);
const perType: Record<string, number[]> = {};
for (const r of results) for (const [k, arr] of Object.entries(r.s.homeSocial)) (perType[k] ??= []).push(...arr);
for (const [k, arr] of Object.entries(perType).sort((a, b) => mean(b[1]) - mean(a[1]))) {
  console.log(`    home→${k.padEnd(12)} mean=${f1(mean(arr))}t  median=${f1(median(arr))}t  max=${Math.max(...arr)}t`);
}
console.log('  stranded samples (first 12):');
results.flatMap((r) => r.s.strandedNotes).slice(0, 12).forEach((n) => console.log('    ' + n));
console.log(`  total stranded flags (home→work >45t): ${results.reduce((a, r) => a + r.s.strandedNotes.length, 0)} of ${allHW.length} agent-trips`);

console.log('\n════════════════ 3. VARIETY ACROSS SEEDS ════════════════');
const types = Object.keys(results[0].s.typePos);
console.log('  type            distinct positions / ' + NUM_SEEDS + '     distinct zones     zone histogram');
for (const t of types) {
  const pos = new Set(results.map((r) => r.s.typePos[t]).filter(Boolean));
  const zc = new Map<string, number>();
  for (const r of results) { const z = r.s.typeZone[t]; if (z) zc.set(z, (zc.get(z) ?? 0) + 1); }
  const hist = [...zc].sort((a, b) => b[1] - a[1]).map(([z, n]) => `${z}:${n}`).join(' ');
  console.log(`  ${t.padEnd(14)} ${String(pos.size).padStart(3)}                        ${String(zc.size).padStart(2)}              ${hist}`);
}
// pairwise map similarity: fraction of types landing in the same zone
let sim = 0, pairs = 0;
for (let i = 0; i < results.length; i++) for (let j = i + 1; j < results.length; j++) {
  const a = results[i].s.typeZone, b = results[j].s.typeZone;
  const ks = Object.keys(a).filter((k) => b[k]);
  sim += ks.filter((k) => a[k] === b[k]).length / ks.length; pairs++;
}
console.log(`  mean pairwise "same zone" agreement between seeds: ${(sim / pairs * 100).toFixed(0)}%  (100% = identical zoning every seed)`);

console.log('\n════════════════ 4/5. ZONING COHERENCE & VENUE SPREAD ════════════════');
for (const cat of ['commercial', 'civic', 'residential']) {
  const rs = results.map((r) => r.s.clusterRatio[cat]).filter(Number.isFinite);
  console.log(`  ${cat.padEnd(12)} mean intra-category distance / mean all-pairs distance = ${f1(mean(rs))}  (<0.8 = clustered, ~1.0 = interleaved/random)`);
}
console.log(`  mean pairwise distance between social venues: ${f1(mean(results.map((r) => r.s.venueSpread)))}t`);
console.log(`  mean pairwise distance between homes:         ${f1(mean(results.map((r) => r.s.homeSpread)))}t`);
const cds: Record<string, number[]> = {};
for (const r of results) for (const [t, d] of Object.entries(r.s.centroidDist)) (cds[t] ??= []).push(d);
console.log('  distance from town centroid (lower = more central):');
for (const [t, ds] of Object.entries(cds).sort((a, b) => mean(a[1]) - mean(b[1])))
  console.log(`    ${t.padEnd(14)} ${f1(mean(ds))}t`);

console.log('\n════════════════ 6. DEAD SPACE ════════════════');
const cov = results.map((r) => r.s.trafficCoverage);
console.log(`  walkable tiles within 2 tiles of any agent route: mean ${(mean(cov) * 100).toFixed(0)}%  min ${(Math.min(...cov) * 100).toFixed(0)}%  max ${(Math.max(...cov) * 100).toFixed(0)}%`);
console.log(`  → mean ${(100 - mean(cov) * 100).toFixed(0)}% of walkable map is never traversed`);
const areas = results.map((r) => r.s.emptyRegion.w * r.s.emptyRegion.h);
console.log(`  largest fully-untraversed rectangle: mean ${f1(mean(areas))} tiles, max ${Math.max(...areas)} tiles`);
results.slice(0, 5).forEach((r) => console.log(`    ${r.s.seed}: ${r.s.emptyRegion.w}x${r.s.emptyRegion.h} at (${r.s.emptyRegion.x},${r.s.emptyRegion.y})`));

console.log('\n════════════════ 7. VENUE CO-LOCATION POTENTIAL ════════════════');
// For each seed: how many distinct social venues sit within N tiles of each other,
// and how many agents' free-time prefs converge on the same venue.
const prefCounts = new Map<string, number>();
for (const a of AGENT_SEEDS) for (const p of a.schedule.freeTimePreferences) prefCounts.set(p, (prefCounts.get(p) ?? 0) + 1);
console.log('  agent free-time demand by venue type:', [...prefCounts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join('  '));
const venueCap: Record<string, number> = {};
for (const l of results[0].g.locations) if (SOCIAL_TYPES.has(l.type) || l.type === 'park') venueCap[l.type] = l.capacity;
console.log('  venue capacity:', Object.entries(venueCap).map(([k, c]) => `${k}=${c}`).join('  '));
// distance from each venue to nearest road tile
const venueRoadDist: Record<string, number[]> = {};
for (const { g } of results) {
  const roads = g.roads;
  for (const l of g.locations) {
    if (!SOCIAL_TYPES.has(l.type) && l.type !== 'park') continue;
    let best = Infinity;
    const x0 = tx(l), y0 = ty(l), w = tw(l), h = th(l);
    for (const r of roads) {
      const dx = Math.max(x0 - r.x, r.x - (x0 + w - 1), 0);
      const dy = Math.max(y0 - r.y, r.y - (y0 + h - 1), 0);
      best = Math.min(best, Math.max(dx, dy));
    }
    (venueRoadDist[l.type] ??= []).push(best);
  }
}
console.log('  venue → nearest road tile (Chebyshev):');
for (const [t, ds] of Object.entries(venueRoadDist).sort((a, b) => mean(b[1]) - mean(a[1])))
  console.log(`    ${t.padEnd(14)} mean=${f1(mean(ds))}t  max=${Math.max(...ds)}t`);

// home → nearest social venue of ANY kind
const nearestVenue: number[] = [];
for (const { g } of results) {
  const vs = g.locations.filter((l) => SOCIAL_TYPES.has(l.type) || l.type === 'park');
  for (const h of g.locations.filter((l) => l.type === 'home')) {
    let best = Infinity;
    for (const vv of vs) best = Math.min(best, Math.hypot(ex(h) - ex(vv), ey(h) - ey(vv)));
    nearestVenue.push(best);
  }
}
console.log(`  home → nearest social venue (euclid): mean=${f1(mean(nearestVenue))}t  max=${f1(Math.max(...nearestVenue))}t`);
console.log('');
